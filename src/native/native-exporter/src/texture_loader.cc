#include "texture_loader.h"
#include <wincodec.h>
#include <cstdio>
#include <vector>

namespace nativeexporter {

// ============================================================================
// Shared WIC decode helper — decodes image to PBGRA pixel buffer
// ============================================================================
static bool decodeToPixels(const std::string& path,
                           std::vector<BYTE>& outPixels,
                           uint32_t& outW, uint32_t& outH) {
    outPixels.clear();
    outW = outH = 0;

    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    IWICImagingFactory* factory = nullptr;
    HRESULT hr = CoCreateInstance(
        CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(&factory));
    if (FAILED(hr)) {
        fprintf(stderr, "[TexLoader] CoCreateInstance(WICFactory) failed: 0x%08X\n", (unsigned)hr);
        return false;
    }

    int wlen = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
    std::vector<wchar_t> wpath(wlen);
    MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, wpath.data(), wlen);

    IWICBitmapDecoder* decoder = nullptr;
    hr = factory->CreateDecoderFromFilename(wpath.data(), nullptr, GENERIC_READ,
                                            WICDecodeMetadataCacheOnDemand, &decoder);
    if (FAILED(hr)) {
        fprintf(stderr, "[TexLoader] CreateDecoder failed for '%s': 0x%08X\n", path.c_str(), (unsigned)hr);
        factory->Release();
        return false;
    }

    IWICBitmapFrameDecode* frame = nullptr;
    hr = decoder->GetFrame(0, &frame);
    if (FAILED(hr)) {
        fprintf(stderr, "[TexLoader] GetFrame failed: 0x%08X\n", (unsigned)hr);
        decoder->Release();
        factory->Release();
        return false;
    }

    UINT imgW = 0, imgH = 0;
    frame->GetSize(&imgW, &imgH);

    IWICFormatConverter* converter = nullptr;
    hr = factory->CreateFormatConverter(&converter);
    if (FAILED(hr)) {
        frame->Release();
        decoder->Release();
        factory->Release();
        return false;
    }

    hr = converter->Initialize(
        frame, GUID_WICPixelFormat32bppPBGRA,
        WICBitmapDitherTypeNone, nullptr, 0.0, WICBitmapPaletteTypeCustom);
    if (FAILED(hr)) {
        fprintf(stderr, "[TexLoader] WIC format convert failed: 0x%08X\n", (unsigned)hr);
        converter->Release();
        frame->Release();
        decoder->Release();
        factory->Release();
        return false;
    }

    UINT stride = imgW * 4;
    UINT bufSize = stride * imgH;
    outPixels.resize(bufSize);
    hr = converter->CopyPixels(nullptr, stride, bufSize, outPixels.data());

    converter->Release();
    frame->Release();
    decoder->Release();
    factory->Release();

    if (FAILED(hr)) {
        fprintf(stderr, "[TexLoader] CopyPixels failed: 0x%08X\n", (unsigned)hr);
        outPixels.clear();
        return false;
    }

    outW = imgW;
    outH = imgH;
    return true;
}

// ============================================================================
// loadImageWIC — create new D3D11 texture + SRV from image file
// ============================================================================
bool loadImageWIC(ID3D11Device* device, const std::string& path, LoadedTexture& out) {
    out = {};

    std::vector<BYTE> pixels;
    uint32_t imgW, imgH;
    if (!decodeToPixels(path, pixels, imgW, imgH)) return false;

    UINT stride = imgW * 4;

    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = imgW;
    desc.Height = imgH;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;

    D3D11_SUBRESOURCE_DATA initData = {};
    initData.pSysMem = pixels.data();
    initData.SysMemPitch = stride;

    ID3D11Texture2D* tex = nullptr;
    HRESULT hr = device->CreateTexture2D(&desc, &initData, &tex);
    if (FAILED(hr)) {
        fprintf(stderr, "[TexLoader] CreateTexture2D failed: 0x%08X\n", (unsigned)hr);
        return false;
    }

    ID3D11ShaderResourceView* srv = nullptr;
    hr = device->CreateShaderResourceView(tex, nullptr, &srv);
    if (FAILED(hr)) {
        fprintf(stderr, "[TexLoader] CreateSRV failed: 0x%08X\n", (unsigned)hr);
        tex->Release();
        return false;
    }

    out.texture = tex;
    out.srv = srv;
    out.width = imgW;
    out.height = imgH;

    fprintf(stderr, "[TexLoader] Loaded '%s' %ux%u → SRV=%p\n",
            path.c_str(), imgW, imgH, (void*)srv);
    return true;
}

// ============================================================================
// updateTextureWIC — update existing DEFAULT texture with new image data
// ============================================================================
bool updateTextureWIC(ID3D11DeviceContext* ctx, const std::string& path,
                      ID3D11Texture2D* texture, uint32_t expectedW, uint32_t expectedH) {
    if (!ctx || !texture) return false;

    std::vector<BYTE> pixels;
    uint32_t imgW, imgH;
    if (!decodeToPixels(path, pixels, imgW, imgH)) return false;

    if (imgW != expectedW || imgH != expectedH) {
        fprintf(stderr, "[TexLoader] updateTextureWIC: size mismatch %ux%u vs expected %ux%u for '%s'\n",
                imgW, imgH, expectedW, expectedH, path.c_str());
        return false;
    }

    UINT stride = imgW * 4;
    ctx->UpdateSubresource(texture, 0, nullptr, pixels.data(), stride, 0);
    return true;
}

// ============================================================================
void releaseTexture(LoadedTexture& tex) {
    if (tex.srv) { tex.srv->Release(); tex.srv = nullptr; }
    if (tex.texture) { tex.texture->Release(); tex.texture = nullptr; }
    tex.width = tex.height = 0;
}

} // namespace nativeexporter
