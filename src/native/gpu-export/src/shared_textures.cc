/**
 * shared_textures.cc — D3D11 shared texture ring buffer implementation
 */

#include "shared_textures.h"
#include "angle_interop.h"

#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <cstdio>
#include <cstring>

// ============================================================================
// Module state
// ============================================================================

struct SharedTextureEntry {
    ID3D11Texture2D*   texture = nullptr;
    ID3D11Texture2D*   staging = nullptr;
    IDXGIKeyedMutex*   keyedMutex = nullptr;
    HANDLE             shareHandle = nullptr;
};

static SharedTextureEntry s_textures[MAX_SHARED_TEXTURES];
static uint32_t s_count = 0;
static uint32_t s_width = 0;
static uint32_t s_height = 0;

// ============================================================================
// Implementation
// ============================================================================

bool createSharedTextures(uint32_t width, uint32_t height, uint32_t count) {
    if (count > MAX_SHARED_TEXTURES) {
        fprintf(stderr, "[shared_textures] count %u exceeds max %d\n", count, MAX_SHARED_TEXTURES);
        return false;
    }

    ID3D11Device* device = getD3D11Device();
    if (!device) {
        fprintf(stderr, "[shared_textures] D3D11 device not available (run probe first)\n");
        return false;
    }

    // Clean up any previous textures
    destroySharedTextures();

    s_width = width;
    s_height = height;

    for (uint32_t i = 0; i < count; i++) {
        // 1. Create shared render target texture with keyed mutex
        D3D11_TEXTURE2D_DESC desc = {};
        desc.Width = width;
        desc.Height = height;
        desc.MipLevels = 1;
        desc.ArraySize = 1;
        desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        desc.SampleDesc.Count = 1;
        desc.Usage = D3D11_USAGE_DEFAULT;
        desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
        // Use simple shared (not keyed mutex) for ANGLE compatibility.
        // Keyed mutex causes E_INVALIDARG in ANGLE's SwapChain11::resetOffscreenColorBuffer.
        // Sync via glFinish() + ordering instead.
        desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED;

        HRESULT hr = device->CreateTexture2D(&desc, nullptr, &s_textures[i].texture);
        if (FAILED(hr)) {
            fprintf(stderr, "[shared_textures] CreateTexture2D[%u] failed: 0x%08lX\n", i, hr);
            destroySharedTextures();
            return false;
        }

        // 2. Get keyed mutex interface (optional — not available with MISC_SHARED)
        s_textures[i].texture->QueryInterface(
            __uuidof(IDXGIKeyedMutex), (void**)&s_textures[i].keyedMutex);
        // keyedMutex will be null with D3D11_RESOURCE_MISC_SHARED — that's fine

        // 3. Get share handle for EGL pbuffer import
        IDXGIResource* dxgiRes = nullptr;
        hr = s_textures[i].texture->QueryInterface(__uuidof(IDXGIResource), (void**)&dxgiRes);
        if (FAILED(hr) || !dxgiRes) {
            fprintf(stderr, "[shared_textures] QueryInterface IDXGIResource[%u] failed: 0x%08lX\n", i, hr);
            destroySharedTextures();
            return false;
        }
        hr = dxgiRes->GetSharedHandle(&s_textures[i].shareHandle);
        dxgiRes->Release();
        if (FAILED(hr) || !s_textures[i].shareHandle) {
            fprintf(stderr, "[shared_textures] GetSharedHandle[%u] failed: 0x%08lX\n", i, hr);
            destroySharedTextures();
            return false;
        }

        // 4. Create staging texture for CPU readback
        D3D11_TEXTURE2D_DESC stagingDesc = {};
        stagingDesc.Width = width;
        stagingDesc.Height = height;
        stagingDesc.MipLevels = 1;
        stagingDesc.ArraySize = 1;
        stagingDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        stagingDesc.SampleDesc.Count = 1;
        stagingDesc.Usage = D3D11_USAGE_STAGING;
        stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;

        hr = device->CreateTexture2D(&stagingDesc, nullptr, &s_textures[i].staging);
        if (FAILED(hr)) {
            fprintf(stderr, "[shared_textures] CreateTexture2D staging[%u] failed: 0x%08lX\n", i, hr);
            destroySharedTextures();
            return false;
        }

        fprintf(stderr, "[shared_textures] Texture[%u] created: %ux%u, handle=%p\n",
                i, width, height, s_textures[i].shareHandle);
    }

    s_count = count;
    fprintf(stderr, "[shared_textures] Created %u shared textures (%ux%u BGRA)\n",
            count, width, height);
    return true;
}

void* getShareHandle(uint32_t index) {
    if (index >= s_count) return nullptr;
    return s_textures[index].shareHandle;
}

bool acquireKeyedMutex(uint32_t index, uint64_t key, uint32_t timeoutMs) {
    if (index >= s_count || !s_textures[index].keyedMutex) return false;
    HRESULT hr = s_textures[index].keyedMutex->AcquireSync(key, timeoutMs);
    if (FAILED(hr)) {
        fprintf(stderr, "[shared_textures] AcquireSync[%u](key=%llu) failed: 0x%08lX\n",
                index, key, hr);
        return false;
    }
    return true;
}

bool releaseKeyedMutex(uint32_t index, uint64_t key) {
    if (index >= s_count || !s_textures[index].keyedMutex) return false;
    HRESULT hr = s_textures[index].keyedMutex->ReleaseSync(key);
    if (FAILED(hr)) {
        fprintf(stderr, "[shared_textures] ReleaseSync[%u](key=%llu) failed: 0x%08lX\n",
                index, key, hr);
        return false;
    }
    return true;
}

bool readTextureToBuffer(uint32_t index, void* outBuf, uint32_t bufSize) {
    if (index >= s_count) return false;

    uint32_t expectedSize = s_width * s_height * 4;
    if (bufSize < expectedSize) {
        fprintf(stderr, "[shared_textures] readTextureToBuffer: buffer too small (%u < %u)\n",
                bufSize, expectedSize);
        return false;
    }

    ID3D11DeviceContext* ctx = getD3D11Context();
    if (!ctx) return false;

    // GPU copy: shared texture → staging texture
    ctx->CopyResource(s_textures[index].staging, s_textures[index].texture);

    // Map staging for CPU read
    D3D11_MAPPED_SUBRESOURCE mapped = {};
    HRESULT hr = ctx->Map(s_textures[index].staging, 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED(hr)) {
        fprintf(stderr, "[shared_textures] Map staging[%u] failed: 0x%08lX\n", index, hr);
        return false;
    }

    // Copy row by row (mapped.RowPitch may differ from width*4)
    const uint32_t rowBytes = s_width * 4;
    uint8_t* dst = (uint8_t*)outBuf;
    uint8_t* src = (uint8_t*)mapped.pData;
    for (uint32_t y = 0; y < s_height; y++) {
        memcpy(dst + y * rowBytes, src + y * mapped.RowPitch, rowBytes);
    }

    ctx->Unmap(s_textures[index].staging, 0);
    return true;
}

uint32_t getSharedTextureCount() { return s_count; }
uint32_t getSharedTextureWidth() { return s_width; }
uint32_t getSharedTextureHeight() { return s_height; }

void destroySharedTextures() {
    for (uint32_t i = 0; i < MAX_SHARED_TEXTURES; i++) {
        if (s_textures[i].keyedMutex) { s_textures[i].keyedMutex->Release(); s_textures[i].keyedMutex = nullptr; }
        if (s_textures[i].staging) { s_textures[i].staging->Release(); s_textures[i].staging = nullptr; }
        if (s_textures[i].texture) { s_textures[i].texture->Release(); s_textures[i].texture = nullptr; }
        s_textures[i].shareHandle = nullptr;
    }
    s_count = 0;
    s_width = 0;
    s_height = 0;
    fprintf(stderr, "[shared_textures] Destroyed all shared textures\n");
}

// ============================================================================
// N-API wrappers
// ============================================================================

Napi::Value CreateSharedTextures(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    uint32_t w = info[0].As<Napi::Number>().Uint32Value();
    uint32_t h = info[1].As<Napi::Number>().Uint32Value();
    uint32_t count = info[2].As<Napi::Number>().Uint32Value();

    bool ok = createSharedTextures(w, h, count);

    Napi::Object result = Napi::Object::New(env);
    result.Set("ok", Napi::Boolean::New(env, ok));
    if (ok) {
        Napi::Array handles = Napi::Array::New(env, count);
        for (uint32_t i = 0; i < count; i++) {
            // Return share handles as hex strings (HANDLE is a pointer, not safe as Number)
            char buf[32];
            snprintf(buf, sizeof(buf), "0x%p", getShareHandle(i));
            handles.Set(i, Napi::String::New(env, buf));
        }
        result.Set("shareHandles", handles);
        result.Set("count", Napi::Number::New(env, count));
        result.Set("width", Napi::Number::New(env, w));
        result.Set("height", Napi::Number::New(env, h));
    }
    return result;
}

Napi::Value AcquireKeyedMutex(const Napi::CallbackInfo& info) {
    uint32_t index = info[0].As<Napi::Number>().Uint32Value();
    uint64_t key = (uint64_t)info[1].As<Napi::Number>().Int64Value();
    uint32_t timeout = info.Length() > 2 ? info[2].As<Napi::Number>().Uint32Value() : 5000;
    return Napi::Boolean::New(info.Env(), acquireKeyedMutex(index, key, timeout));
}

Napi::Value ReleaseKeyedMutex(const Napi::CallbackInfo& info) {
    uint32_t index = info[0].As<Napi::Number>().Uint32Value();
    uint64_t key = (uint64_t)info[1].As<Napi::Number>().Int64Value();
    return Napi::Boolean::New(info.Env(), releaseKeyedMutex(index, key));
}

Napi::Value ReadTextureToBuffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    uint32_t index = info[0].As<Napi::Number>().Uint32Value();

    uint32_t size = s_width * s_height * 4;
    if (size == 0) return env.Null();

    // Return a Node.js Buffer containing the BGRA pixels
    Napi::Buffer<uint8_t> buf = Napi::Buffer<uint8_t>::New(env, size);
    bool ok = readTextureToBuffer(index, buf.Data(), size);
    if (!ok) return env.Null();
    return buf;
}

Napi::Value DestroySharedTextures(const Napi::CallbackInfo& info) {
    destroySharedTextures();
    return Napi::Boolean::New(info.Env(), true);
}
