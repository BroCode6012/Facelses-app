#include "d3d11_device.h"
#include <dxgi1_2.h>
#include <d3d11_1.h>
#include <d3d11_4.h>
#include <cmath>
#include <cstring>
#include <cstdio>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

namespace nativeexporter {

static ID3D11Device* s_device = nullptr;
static ID3D11DeviceContext* s_context = nullptr;
static ID3D11Texture2D* s_renderTarget = nullptr;
static ID3D11RenderTargetView* s_rtv = nullptr;
static IDXGIAdapter1* s_adapter = nullptr;
static std::string s_adapterDesc;
static uint32_t s_width = 0, s_height = 0;

bool initD3D11() {
    if (s_device) return true; // already initialized

    // Step 1: Enumerate adapters with CreateDXGIFactory1 → EnumAdapters1
    IDXGIFactory1* factory = nullptr;
    HRESULT hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void**)&factory);
    if (FAILED(hr)) {
        fprintf(stderr, "[D3D11] CreateDXGIFactory1 failed: hr=0x%08X\n", (unsigned)hr);
        return false;
    }

    IDXGIAdapter1* nvidiaAdapter = nullptr;

    fprintf(stderr, "[D3D11] === Adapter Enumeration ===\n");
    for (UINT i = 0; ; i++) {
        IDXGIAdapter1* adapter = nullptr;
        if (factory->EnumAdapters1(i, &adapter) == DXGI_ERROR_NOT_FOUND) break;

        DXGI_ADAPTER_DESC1 desc;
        adapter->GetDesc1(&desc);

        char narrowDesc[256] = {};
        WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, narrowDesc, sizeof(narrowDesc), nullptr, nullptr);

        bool isSoftware = (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0;

        fprintf(stderr, "[D3D11]   Adapter %u: \"%s\"\n", i, narrowDesc);
        fprintf(stderr, "[D3D11]     VendorId=0x%04X DeviceId=0x%04X LUID=%08X:%08X Flags=%u%s\n",
                desc.VendorId, desc.DeviceId,
                desc.AdapterLuid.HighPart, desc.AdapterLuid.LowPart,
                desc.Flags, isSoftware ? " (SOFTWARE - skipping)" : "");
        fprintf(stderr, "[D3D11]     DedicatedVideoMem=%llu SharedSystemMem=%llu\n",
                (unsigned long long)desc.DedicatedVideoMemory,
                (unsigned long long)desc.SharedSystemMemory);

        if (isSoftware) {
            adapter->Release();
            continue;
        }

        // Select NVIDIA adapter by VendorId 0x10DE
        if (!nvidiaAdapter && desc.VendorId == 0x10DE) {
            nvidiaAdapter = adapter;
            s_adapterDesc = narrowDesc;
            fprintf(stderr, "[D3D11]     >> SELECTED (NVIDIA)\n");
        } else {
            adapter->Release();
        }
    }

    factory->Release();

    if (!nvidiaAdapter) {
        fprintf(stderr, "[D3D11] ERROR: No NVIDIA adapter found!\n");
        return false;
    }
    s_adapter = nvidiaAdapter;

    // Step 2: Create D3D11 device
    D3D_FEATURE_LEVEL featureLevels[] = { D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0 };
    D3D_FEATURE_LEVEL actualLevel;

    // Attempt A: BGRA_SUPPORT (always needed for BGRA textures)
    UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;

    hr = D3D11CreateDevice(
        s_adapter,
        D3D_DRIVER_TYPE_UNKNOWN,
        nullptr,
        flags,
        featureLevels, 2,
        D3D11_SDK_VERSION,
        &s_device,
        &actualLevel,
        &s_context
    );
    fprintf(stderr, "[D3D11] CreateDevice(BGRA_SUPPORT): hr=0x%08X\n", (unsigned)hr);

    // Attempt B: no flags
    if (FAILED(hr)) {
        hr = D3D11CreateDevice(
            s_adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            nullptr,
            0,
            featureLevels, 2,
            D3D11_SDK_VERSION,
            &s_device,
            &actualLevel,
            &s_context
        );
        fprintf(stderr, "[D3D11] CreateDevice(no flags): hr=0x%08X\n", (unsigned)hr);
    }

    if (FAILED(hr)) {
        fprintf(stderr, "[D3D11] ERROR: D3D11CreateDevice failed\n");
        s_adapter->Release();
        s_adapter = nullptr;
        return false;
    }

    // Step 3: Diagnostics
    fprintf(stderr, "[D3D11] Device: %p  Context: %p  FeatureLevel: 0x%X (%s)\n",
            (void*)s_device, (void*)s_context, (unsigned)actualLevel,
            actualLevel == D3D_FEATURE_LEVEL_11_1 ? "11.1" :
            actualLevel == D3D_FEATURE_LEVEL_11_0 ? "11.0" : "other");

    // Query ID3D11Device1 (optional, for diagnostics)
    ID3D11Device1* dev1 = nullptr;
    hr = s_device->QueryInterface(__uuidof(ID3D11Device1), (void**)&dev1);
    fprintf(stderr, "[D3D11] ID3D11Device1 QueryInterface: hr=0x%08X %s\n",
            (unsigned)hr, SUCCEEDED(hr) ? "OK" : "NOT AVAILABLE");
    if (dev1) dev1->Release();

    // Multithread protection
    ID3D11Multithread* pMT = nullptr;
    hr = s_device->QueryInterface(__uuidof(ID3D11Multithread), (void**)&pMT);
    if (SUCCEEDED(hr) && pMT) {
        pMT->SetMultithreadProtected(TRUE);
        pMT->Release();
        fprintf(stderr, "[D3D11] Multithread protection: ENABLED\n");
    } else {
        fprintf(stderr, "[D3D11] Multithread protection: NOT AVAILABLE (hr=0x%08X)\n", (unsigned)hr);
    }

    // Verify BGRA texture creation (16x16 smoke test)
    {
        D3D11_TEXTURE2D_DESC testDesc = {};
        testDesc.Width = 16;
        testDesc.Height = 16;
        testDesc.MipLevels = 1;
        testDesc.ArraySize = 1;
        testDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        testDesc.SampleDesc.Count = 1;
        testDesc.Usage = D3D11_USAGE_DEFAULT;
        testDesc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;

        ID3D11Texture2D* testTex = nullptr;
        hr = s_device->CreateTexture2D(&testDesc, nullptr, &testTex);
        fprintf(stderr, "[D3D11] BGRA 16x16 RT+SR texture: hr=0x%08X %s\n",
                (unsigned)hr, SUCCEEDED(hr) ? "OK" : "FAILED");
        if (testTex) testTex->Release();
    }

    fprintf(stderr, "[D3D11] === Device Init Complete ===\n");
    return true;
}

bool createRenderTarget(uint32_t width, uint32_t height) {
    if (!s_device) return false;

    // Release old render target if any
    if (s_rtv) { s_rtv->Release(); s_rtv = nullptr; }
    if (s_renderTarget) { s_renderTarget->Release(); s_renderTarget = nullptr; }

    s_width = width;
    s_height = height;

    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = width;
    desc.Height = height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.SampleDesc.Quality = 0;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET;
    desc.CPUAccessFlags = 0;
    desc.MiscFlags = 0;

    HRESULT hr = s_device->CreateTexture2D(&desc, nullptr, &s_renderTarget);
    if (FAILED(hr)) return false;

    hr = s_device->CreateRenderTargetView(s_renderTarget, nullptr, &s_rtv);
    if (FAILED(hr)) {
        s_renderTarget->Release();
        s_renderTarget = nullptr;
        return false;
    }

    return true;
}

void renderSyntheticFrame(uint32_t frameIdx, uint32_t totalFrames) {
    if (!s_rtv || !s_context) return;

    // Cycle hue across frames
    double t = (double)frameIdx / (double)(totalFrames > 1 ? totalFrames : 1);
    float r = (float)(sin(t * 2.0 * M_PI) * 0.5 + 0.5);
    float g = (float)(sin(t * 2.0 * M_PI + 2.094) * 0.5 + 0.5);
    float b = (float)(sin(t * 2.0 * M_PI + 4.189) * 0.5 + 0.5);

    renderSolidColor(r, g, b, 1.0f);
}

void renderSolidColor(float r, float g, float b, float a) {
    if (!s_rtv || !s_context) return;

    float clearColor[4] = { r, g, b, a };
    s_context->ClearRenderTargetView(s_rtv, clearColor);
    s_context->Flush();
}

void shutdown() {
    if (s_rtv) { s_rtv->Release(); s_rtv = nullptr; }
    if (s_renderTarget) { s_renderTarget->Release(); s_renderTarget = nullptr; }
    if (s_context) { s_context->Release(); s_context = nullptr; }
    if (s_device) { s_device->Release(); s_device = nullptr; }
    if (s_adapter) { s_adapter->Release(); s_adapter = nullptr; }
    s_width = s_height = 0;
    s_adapterDesc.clear();
}

ID3D11Device* getDevice() { return s_device; }
ID3D11DeviceContext* getContext() { return s_context; }
ID3D11Texture2D* getRenderTarget() { return s_renderTarget; }
std::string getAdapterDescription() { return s_adapterDesc; }

} // namespace nativeexporter
