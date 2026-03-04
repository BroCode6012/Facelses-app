/**
 * angle_interop.cc — EGL/ANGLE D3D11 interop implementation
 *
 * Dynamically loads EGL functions from Electron's libEGL.dll via LoadLibrary.
 * Probes the EGL display for D3D11-related extensions.
 *
 * Strategy: "Owned Shared Texture" (B2)
 *   We create our OWN D3D11 device, make shared textures, and import them
 *   into ANGLE via EGL_ANGLE_d3d_share_handle_client_buffer. No need to
 *   extract ANGLE's internal D3D11 device pointer.
 *
 * Key EGL extensions used:
 *   EGL_ANGLE_d3d_share_handle_client_buffer — import shared D3D11 textures as pbuffer
 *   EGL_ANGLE_image_d3d11_texture            — create EGL image from D3D11 texture
 *   EGL_ANGLE_keyed_mutex                    — GPU synchronization
 */

#include "angle_interop.h"

#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <cstdint>
#include <cstdio>
#include <sstream>

// ============================================================================
// EGL type definitions (avoid requiring EGL headers at build time)
// ============================================================================

typedef void*          EGLDisplay;
typedef void*          EGLDeviceEXT;
typedef unsigned int   EGLBoolean;
typedef int32_t        EGLint;
typedef intptr_t       EGLAttrib;

#define EGL_DEFAULT_DISPLAY      ((void*)0)
#define EGL_NO_DISPLAY           ((EGLDisplay)0)
#define EGL_TRUE                 1
#define EGL_FALSE                0
#define EGL_EXTENSIONS           0x3055
#define EGL_SUCCESS              0x3000

// EGL_EXT_device_query (optional — not all ANGLE builds expose this)
#define EGL_DEVICE_EXT           0x322C

// EGL_ANGLE_device_d3d (optional)
#define EGL_D3D11_DEVICE_ANGLE   0x33A1

// ============================================================================
// EGLAPIENTRY definition (matches EGL spec calling convention on Windows)
// ============================================================================
#ifndef EGLAPIENTRY
#define EGLAPIENTRY __stdcall
#endif

// ============================================================================
// EGL function pointer typedefs
// ============================================================================

typedef EGLDisplay  (EGLAPIENTRY *pfn_eglGetDisplay)(void* display_id);
typedef EGLBoolean  (EGLAPIENTRY *pfn_eglInitialize)(EGLDisplay dpy, EGLint* major, EGLint* minor);
typedef const char* (EGLAPIENTRY *pfn_eglQueryString)(EGLDisplay dpy, EGLint name);
typedef EGLint      (EGLAPIENTRY *pfn_eglGetError)(void);
typedef void*       (EGLAPIENTRY *pfn_eglGetProcAddress)(const char* procname);

// Extension function pointers (optional — resolved if available)
typedef EGLBoolean  (EGLAPIENTRY *pfn_eglQueryDisplayAttribEXT)(EGLDisplay dpy, EGLint attribute, EGLAttrib* value);
typedef EGLBoolean  (EGLAPIENTRY *pfn_eglQueryDeviceAttribEXT)(EGLDeviceEXT device, EGLint attribute, EGLAttrib* value);
typedef const char* (EGLAPIENTRY *pfn_eglQueryDeviceStringEXT)(EGLDeviceEXT device, EGLint name);

// ============================================================================
// Module state — EGL function pointers loaded once
// ============================================================================

static HMODULE s_eglLib = nullptr;
static bool s_eglLoaded = false;

static pfn_eglGetDisplay          s_eglGetDisplay = nullptr;
static pfn_eglInitialize          s_eglInitialize = nullptr;
static pfn_eglQueryString         s_eglQueryString = nullptr;
static pfn_eglGetError            s_eglGetError = nullptr;
static pfn_eglGetProcAddress      s_eglGetProcAddress = nullptr;

// Optional extension functions
static pfn_eglQueryDisplayAttribEXT  s_eglQueryDisplayAttribEXT = nullptr;
static pfn_eglQueryDeviceAttribEXT   s_eglQueryDeviceAttribEXT = nullptr;
static pfn_eglQueryDeviceStringEXT   s_eglQueryDeviceStringEXT = nullptr;

// ============================================================================
// Module state — D3D11 device (created by us, not ANGLE's)
// ============================================================================

static ID3D11Device*        s_d3d11Device = nullptr;
static ID3D11DeviceContext*  s_d3d11Context = nullptr;
static D3D_FEATURE_LEVEL     s_featureLevel = D3D_FEATURE_LEVEL_11_0;

// ============================================================================
// Helper: load EGL library and resolve core + extension functions
// ============================================================================

static bool loadEGL() {
    if (s_eglLoaded) return (s_eglLib != nullptr);

    s_eglLoaded = true;

    // Try loading libEGL.dll — Electron ships it alongside the executable
    s_eglLib = LoadLibraryA("libEGL.dll");
    if (!s_eglLib) {
        s_eglLib = LoadLibraryA("libEGL");
        if (!s_eglLib) {
            fprintf(stderr, "[gpu_export] Failed to load libEGL.dll\n");
            return false;
        }
    }

    // Core EGL functions
    s_eglGetDisplay    = (pfn_eglGetDisplay)GetProcAddress(s_eglLib, "eglGetDisplay");
    s_eglInitialize    = (pfn_eglInitialize)GetProcAddress(s_eglLib, "eglInitialize");
    s_eglQueryString   = (pfn_eglQueryString)GetProcAddress(s_eglLib, "eglQueryString");
    s_eglGetError      = (pfn_eglGetError)GetProcAddress(s_eglLib, "eglGetError");
    s_eglGetProcAddress = (pfn_eglGetProcAddress)GetProcAddress(s_eglLib, "eglGetProcAddress");

    if (!s_eglGetDisplay || !s_eglInitialize || !s_eglQueryString || !s_eglGetProcAddress) {
        fprintf(stderr, "[gpu_export] Failed to resolve core EGL functions\n");
        FreeLibrary(s_eglLib);
        s_eglLib = nullptr;
        return false;
    }

    // Optional extension functions — may be nullptr
    s_eglQueryDisplayAttribEXT = (pfn_eglQueryDisplayAttribEXT)
        s_eglGetProcAddress("eglQueryDisplayAttribEXT");
    s_eglQueryDeviceAttribEXT = (pfn_eglQueryDeviceAttribEXT)
        s_eglGetProcAddress("eglQueryDeviceAttribEXT");
    s_eglQueryDeviceStringEXT = (pfn_eglQueryDeviceStringEXT)
        s_eglGetProcAddress("eglQueryDeviceStringEXT");

    return true;
}

// ============================================================================
// Helper: split extension string into vector
// ============================================================================

static std::vector<std::string> splitExtensions(const char* extStr) {
    std::vector<std::string> result;
    if (!extStr) return result;
    std::istringstream stream(extStr);
    std::string token;
    while (stream >> token) {
        result.push_back(token);
    }
    return result;
}

// ============================================================================
// Helper: check if extension is present
// ============================================================================

static bool hasExtension(const std::vector<std::string>& exts, const char* name) {
    for (const auto& ext : exts) {
        if (ext == name) return true;
    }
    return false;
}

// ============================================================================
// Helper: create our own D3D11 device on the default adapter
// ============================================================================

static bool createD3D11Device() {
    if (s_d3d11Device) return true;

    D3D_FEATURE_LEVEL featureLevels[] = {
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0
    };

    UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
#ifdef _DEBUG
    flags |= D3D11_CREATE_DEVICE_DEBUG;
#endif

    HRESULT hr = D3D11CreateDevice(
        nullptr,                    // default adapter (same as ANGLE typically uses)
        D3D_DRIVER_TYPE_HARDWARE,
        nullptr,
        flags,
        featureLevels,
        _countof(featureLevels),
        D3D11_SDK_VERSION,
        &s_d3d11Device,
        &s_featureLevel,
        &s_d3d11Context
    );

    if (FAILED(hr)) {
        fprintf(stderr, "[gpu_export] D3D11CreateDevice failed: 0x%08lX\n", hr);
        return false;
    }

    return true;
}

// ============================================================================
// Probe implementation
// ============================================================================

AngleProbeResult probeAngleD3D11Impl() {
    AngleProbeResult result;

    // 1. Load EGL library
    if (!loadEGL()) {
        result.reason = "EGL_LOAD_FAILED";
        result.error = "Could not load libEGL.dll";
        return result;
    }

    // 2. Get the default EGL display
    EGLDisplay display = s_eglGetDisplay(EGL_DEFAULT_DISPLAY);
    if (display == EGL_NO_DISPLAY) {
        result.reason = "ANGLE_NOT_D3D11";
        result.error = "eglGetDisplay returned EGL_NO_DISPLAY (is --in-process-gpu active?)";
        return result;
    }

    // 3. Initialize EGL
    EGLint major = 0, minor = 0;
    if (!s_eglInitialize(display, &major, &minor)) {
        EGLint err = s_eglGetError ? s_eglGetError() : 0;
        result.reason = "ANGLE_NOT_D3D11";
        result.error = "eglInitialize failed (error " + std::to_string(err) + ")";
        return result;
    }

    // 4. Query extensions
    const char* extStr = s_eglQueryString(display, EGL_EXTENSIONS);
    result.eglExtensions = splitExtensions(extStr);

    // 5. Check required extensions for B2 "Owned Shared Texture" approach
    //    We need: share_handle_client_buffer to import our D3D11 textures into ANGLE
    bool hasShareHandle = hasExtension(result.eglExtensions,
        "EGL_ANGLE_d3d_share_handle_client_buffer");
    bool hasD3DTexture = hasExtension(result.eglExtensions,
        "EGL_ANGLE_d3d_texture_client_buffer");
    bool hasImageD3D11 = hasExtension(result.eglExtensions,
        "EGL_ANGLE_image_d3d11_texture");

    if (!hasShareHandle && !hasD3DTexture && !hasImageD3D11) {
        result.reason = "EGL_EXT_MISSING";
        result.error = "None of the D3D11 texture sharing extensions available "
                       "(need EGL_ANGLE_d3d_share_handle_client_buffer, "
                       "EGL_ANGLE_d3d_texture_client_buffer, or "
                       "EGL_ANGLE_image_d3d11_texture)";
        return result;
    }

    // Record which sharing path is available
    result.sharingMethod = hasShareHandle ? "share_handle_client_buffer"
                         : hasD3DTexture  ? "d3d_texture_client_buffer"
                         :                  "image_d3d11_texture";

    // 6. Try optional EGL_EXT_device_query path for ANGLE's own D3D11 device
    bool gotAngleDevice = false;
    if (s_eglQueryDisplayAttribEXT && s_eglQueryDeviceAttribEXT &&
        hasExtension(result.eglExtensions, "EGL_EXT_device_query")) {

        EGLAttrib deviceAttrib = 0;
        if (s_eglQueryDisplayAttribEXT(display, EGL_DEVICE_EXT, &deviceAttrib) && deviceAttrib) {
            EGLDeviceEXT eglDevice = (EGLDeviceEXT)deviceAttrib;

            EGLAttrib d3d11DeviceAttrib = 0;
            if (s_eglQueryDeviceAttribEXT(eglDevice, EGL_D3D11_DEVICE_ANGLE, &d3d11DeviceAttrib) &&
                d3d11DeviceAttrib) {

                ID3D11Device* angleDevice = reinterpret_cast<ID3D11Device*>(d3d11DeviceAttrib);

                // Query adapter info from ANGLE's device
                IDXGIDevice* dxgiDevice = nullptr;
                HRESULT hr = angleDevice->QueryInterface(__uuidof(IDXGIDevice), (void**)&dxgiDevice);
                if (SUCCEEDED(hr) && dxgiDevice) {
                    IDXGIAdapter* adapter = nullptr;
                    hr = dxgiDevice->GetAdapter(&adapter);
                    if (SUCCEEDED(hr) && adapter) {
                        DXGI_ADAPTER_DESC desc;
                        if (SUCCEEDED(adapter->GetDesc(&desc))) {
                            char descBuf[256];
                            WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1,
                                                descBuf, sizeof(descBuf), nullptr, nullptr);
                            result.adapterDescription = descBuf;

                            char luidBuf[32];
                            snprintf(luidBuf, sizeof(luidBuf), "%08X:%08X",
                                     desc.AdapterLuid.HighPart, desc.AdapterLuid.LowPart);
                            result.adapterLuid = luidBuf;
                        }
                        adapter->Release();
                    }
                    dxgiDevice->Release();
                }

                // Get renderer string
                if (s_eglQueryDeviceStringEXT) {
                    const char* renderer = s_eglQueryDeviceStringEXT(eglDevice, 0x335F);
                    if (renderer) result.renderer = renderer;
                }

                gotAngleDevice = true;
            }
        }
    }

    // 7. Create our own D3D11 device (this is what we'll use for shared textures + NVENC)
    if (!createD3D11Device()) {
        result.reason = "ANGLE_NOT_D3D11";
        result.error = "Failed to create D3D11 device for texture sharing";
        return result;
    }

    // 8. Query adapter info from our device (if we didn't get it from ANGLE)
    if (result.adapterDescription.empty()) {
        IDXGIDevice* dxgiDevice = nullptr;
        HRESULT hr = s_d3d11Device->QueryInterface(__uuidof(IDXGIDevice), (void**)&dxgiDevice);
        if (SUCCEEDED(hr) && dxgiDevice) {
            IDXGIAdapter* adapter = nullptr;
            hr = dxgiDevice->GetAdapter(&adapter);
            if (SUCCEEDED(hr) && adapter) {
                DXGI_ADAPTER_DESC desc;
                if (SUCCEEDED(adapter->GetDesc(&desc))) {
                    char descBuf[256];
                    WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1,
                                        descBuf, sizeof(descBuf), nullptr, nullptr);
                    result.adapterDescription = descBuf;

                    char luidBuf[32];
                    snprintf(luidBuf, sizeof(luidBuf), "%08X:%08X",
                             desc.AdapterLuid.HighPart, desc.AdapterLuid.LowPart);
                    result.adapterLuid = luidBuf;

                    // Check for software renderer
                    if (desc.VendorId == 0x1AE0 ||
                        result.adapterDescription.find("SwiftShader") != std::string::npos ||
                        result.adapterDescription.find("Microsoft Basic") != std::string::npos) {
                        result.reason = "ANGLE_NOT_D3D11";
                        result.error = "Software renderer detected: " + result.adapterDescription;
                        adapter->Release();
                        dxgiDevice->Release();
                        return result;
                    }
                }
                adapter->Release();
            }
            dxgiDevice->Release();
        }
    }

    if (result.renderer.empty()) {
        result.renderer = result.adapterDescription;
    }

    // 9. Quick validation: create a small shared texture to verify the path works
    {
        D3D11_TEXTURE2D_DESC texDesc = {};
        texDesc.Width = 64;
        texDesc.Height = 64;
        texDesc.MipLevels = 1;
        texDesc.ArraySize = 1;
        texDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        texDesc.SampleDesc.Count = 1;
        texDesc.Usage = D3D11_USAGE_DEFAULT;
        texDesc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
        texDesc.MiscFlags = D3D11_RESOURCE_MISC_SHARED;

        ID3D11Texture2D* testTex = nullptr;
        HRESULT hr = s_d3d11Device->CreateTexture2D(&texDesc, nullptr, &testTex);
        if (FAILED(hr)) {
            result.reason = "ANGLE_NOT_D3D11";
            result.error = "Failed to create shared D3D11 texture: 0x" +
                           ([hr]() { char buf[16]; snprintf(buf, sizeof(buf), "%08lX", hr); return std::string(buf); })();
            return result;
        }

        // Verify we can get a share handle
        IDXGIResource* dxgiRes = nullptr;
        hr = testTex->QueryInterface(__uuidof(IDXGIResource), (void**)&dxgiRes);
        if (SUCCEEDED(hr) && dxgiRes) {
            HANDLE shareHandle = nullptr;
            hr = dxgiRes->GetSharedHandle(&shareHandle);
            if (FAILED(hr) || !shareHandle) {
                result.reason = "ANGLE_NOT_D3D11";
                result.error = "Failed to get share handle from D3D11 texture";
                dxgiRes->Release();
                testTex->Release();
                return result;
            }
            dxgiRes->Release();
        }
        testTex->Release();
    }

    // Success!
    result.ok = true;
    return result;
}

// ============================================================================
// Accessors — used by shared_textures.cc and egl_pbuffer.cc
// ============================================================================

ID3D11Device* getD3D11Device() { return s_d3d11Device; }
ID3D11DeviceContext* getD3D11Context() { return s_d3d11Context; }

void* getEglDisplay() {
    if (!loadEGL()) return nullptr;
    return s_eglGetDisplay(EGL_DEFAULT_DISPLAY);
}

void* getEglGetProcAddress() {
    if (!loadEGL()) return nullptr;
    return (void*)s_eglGetProcAddress;
}

bool ensureEglLoaded() { return loadEGL(); }
void* getEglLibraryHandle() { return (void*)s_eglLib; }

// ============================================================================
// N-API wrapper
// ============================================================================

Napi::Value ProbeAngleD3D11(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    AngleProbeResult probe = probeAngleD3D11Impl();

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("ok", Napi::Boolean::New(env, probe.ok));

    if (!probe.ok) {
        obj.Set("reason", Napi::String::New(env, probe.reason));
        if (!probe.error.empty()) {
            obj.Set("error", Napi::String::New(env, probe.error));
        }
    }

    // Always include details if we got any
    Napi::Object details = Napi::Object::New(env);
    if (!probe.renderer.empty()) {
        details.Set("renderer", Napi::String::New(env, probe.renderer));
    }
    if (!probe.adapterDescription.empty()) {
        details.Set("adapterDescription", Napi::String::New(env, probe.adapterDescription));
    }
    if (!probe.adapterLuid.empty()) {
        details.Set("adapterLuid", Napi::String::New(env, probe.adapterLuid));
    }
    if (!probe.sharingMethod.empty()) {
        details.Set("sharingMethod", Napi::String::New(env, probe.sharingMethod));
    }
    if (!probe.eglExtensions.empty()) {
        Napi::Array exts = Napi::Array::New(env, probe.eglExtensions.size());
        for (size_t i = 0; i < probe.eglExtensions.size(); i++) {
            exts.Set((uint32_t)i, Napi::String::New(env, probe.eglExtensions[i]));
        }
        details.Set("eglExtensions", exts);
    }
    obj.Set("details", details);

    return obj;
}
