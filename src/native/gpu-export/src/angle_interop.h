#pragma once
/**
 * angle_interop.h — EGL/ANGLE D3D11 interop
 *
 * Dynamically loads libEGL.dll (shipped with Electron/Chromium)
 * and probes for D3D11 shared texture support:
 *   - EGL display + extensions
 *   - Own D3D11 device (for shared textures + NVENC)
 *   - GPU adapter info (LUID, description)
 *   - Sharing method (share_handle, d3d_texture, image_d3d11)
 *
 * All EGL functions are loaded via GetProcAddress (no link-time dependency).
 * Uses "Owned Shared Texture" (B2) approach — does NOT require
 * EGL_EXT_device_query to extract ANGLE's internal D3D11 device.
 */

#include <napi.h>
#include <string>
#include <vector>

struct AngleProbeResult {
    bool ok = false;
    std::string reason;
    std::string renderer;
    std::string adapterDescription;
    std::string adapterLuid;
    std::string sharingMethod;       // which EGL extension for texture sharing
    std::vector<std::string> eglExtensions;
    std::string error;
};

// Probe ANGLE's D3D11 backend. Thread-safe, can be called multiple times.
AngleProbeResult probeAngleD3D11Impl();

// N-API wrapper: returns JS object { ok, reason?, details? }
Napi::Value ProbeAngleD3D11(const Napi::CallbackInfo& info);

// Forward declarations for D3D11 types (avoid including d3d11.h in header)
struct ID3D11Device;
struct ID3D11DeviceContext;

// Accessors for shared_textures.cc and egl_pbuffer.cc
ID3D11Device* getD3D11Device();
ID3D11DeviceContext* getD3D11Context();
void* getEglDisplay();             // returns EGLDisplay (void*)
void* getEglGetProcAddress();      // returns pfn_eglGetProcAddress cast to void*
bool ensureEglLoaded();
void* getEglLibraryHandle();       // returns HMODULE for GetProcAddress of core EGL funcs
