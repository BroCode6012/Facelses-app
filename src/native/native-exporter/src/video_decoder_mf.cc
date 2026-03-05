#include "video_decoder_mf.h"
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mferror.h>
#include <propvarutil.h>
#include <d3d11_1.h>
#include <dxgi.h>
#include <cstdio>
#include <cstring>
#include <atomic>

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfreadwrite.lib")
#pragma comment(lib, "mfuuid.lib")

namespace nativeexporter {

// ============================================================================
// MF session ref-count
// ============================================================================
static std::atomic<int> s_mfRefCount{0};

void mfStartup() {
    if (s_mfRefCount.fetch_add(1) == 0) {
        HRESULT hr = MFStartup(MF_VERSION);
        if (FAILED(hr)) {
            fprintf(stderr, "[MFDecode] MFStartup failed: 0x%08X\n", (unsigned)hr);
        } else {
            fprintf(stderr, "[MFDecode] MFStartup OK\n");
        }
    }
}

void mfShutdown() {
    if (s_mfRefCount.fetch_sub(1) == 1) {
        MFShutdown();
        fprintf(stderr, "[MFDecode] MFShutdown OK\n");
    }
}

// ============================================================================
// VideoDecoder
// ============================================================================

VideoDecoder::VideoDecoder() {}

VideoDecoder::~VideoDecoder() {
    close();
}

VideoDecoder::VideoDecoder(VideoDecoder&& other) noexcept
    : m_reader(other.m_reader), m_device(other.m_device),
      m_compositorTex(other.m_compositorTex), m_srv(other.m_srv),
      m_srvUV(other.m_srvUV),
      m_dxgiManager(other.m_dxgiManager), m_resetToken(other.m_resetToken),
      m_dxvaEnabled(other.m_dxvaEnabled), m_isNV12(other.m_isNV12),
      m_width(other.m_width), m_height(other.m_height),
      m_duration(other.m_duration), m_lastDecodedTime(other.m_lastDecodedTime),
      m_opened(other.m_opened)
{
    other.m_reader = nullptr;
    other.m_device = nullptr;
    other.m_compositorTex = nullptr;
    other.m_srv = nullptr;
    other.m_srvUV = nullptr;
    other.m_dxgiManager = nullptr;
    other.m_opened = false;
    other.m_lastDecodedTime = -1.0;
}

VideoDecoder& VideoDecoder::operator=(VideoDecoder&& other) noexcept {
    if (this != &other) {
        close();
        m_reader = other.m_reader;
        m_device = other.m_device;
        m_compositorTex = other.m_compositorTex;
        m_srv = other.m_srv;
        m_srvUV = other.m_srvUV;
        m_dxgiManager = other.m_dxgiManager;
        m_resetToken = other.m_resetToken;
        m_dxvaEnabled = other.m_dxvaEnabled;
        m_isNV12 = other.m_isNV12;
        m_width = other.m_width;
        m_height = other.m_height;
        m_duration = other.m_duration;
        m_lastDecodedTime = other.m_lastDecodedTime;
        m_opened = other.m_opened;
        other.m_reader = nullptr;
        other.m_device = nullptr;
        other.m_compositorTex = nullptr;
        other.m_srv = nullptr;
        other.m_srvUV = nullptr;
        other.m_dxgiManager = nullptr;
        other.m_opened = false;
        other.m_lastDecodedTime = -1.0;
    }
    return *this;
}

// ============================================================================
// open() — tries DXVA NV12 first, falls back to CPU BGRA
// ============================================================================
bool VideoDecoder::open(ID3D11Device* device, const std::string& path) {
    if (m_opened) close();
    m_device = device;

    // Convert path to wide string
    int wlen = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
    if (wlen <= 0) {
        fprintf(stderr, "[MFDecode] Invalid path encoding: '%s'\n", path.c_str());
        return false;
    }
    wchar_t* wpath = new wchar_t[wlen];
    MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, wpath, wlen);

    // Try DXVA NV12 path first
    bool ok = openDXVA(wpath);
    if (!ok) {
        fprintf(stderr, "[MFDecode] DXVA/NV12 path failed, falling back to CPU decode\n");
        if (m_reader) { m_reader->Release(); m_reader = nullptr; }
        if (m_dxgiManager) { m_dxgiManager->Release(); m_dxgiManager = nullptr; }
        m_dxvaEnabled = false;
        m_isNV12 = false;
        ok = openCPU(wpath);
    }

    delete[] wpath;
    if (!ok) return false;

    // Read dimensions from actual output type
    IMFMediaType* actualType = nullptr;
    HRESULT hr = m_reader->GetCurrentMediaType(
        (DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM, &actualType);
    if (FAILED(hr)) {
        fprintf(stderr, "[MFDecode] GetCurrentMediaType failed: 0x%08X\n", (unsigned)hr);
        close();
        return false;
    }

    UINT32 w = 0, h = 0;
    MFGetAttributeSize(actualType, MF_MT_FRAME_SIZE, &w, &h);

    GUID subtype = {};
    actualType->GetGUID(MF_MT_SUBTYPE, &subtype);
    actualType->Release();

    if (w == 0 || h == 0) {
        fprintf(stderr, "[MFDecode] Got 0x0 frame size\n");
        close();
        return false;
    }
    m_width = w;
    m_height = h;

    // Confirm actual subtype
    if (subtype == MFVideoFormat_NV12) {
        m_isNV12 = true;
        fprintf(stderr, "[MFDecode] Output subtype: NV12 (GPU surface)\n");
    } else if (subtype == MFVideoFormat_ARGB32) {
        m_isNV12 = false;
        fprintf(stderr, "[MFDecode] Output subtype: ARGB32/BGRA (%s)\n",
                m_dxvaEnabled ? "GPU surface" : "CPU buffer");
    } else {
        m_isNV12 = false;
        fprintf(stderr, "[MFDecode] Output subtype: {%08X-...} (%s)\n", subtype.Data1,
                m_dxvaEnabled ? "GPU" : "CPU");
    }

    // Get duration
    PROPVARIANT var;
    PropVariantInit(&var);
    hr = m_reader->GetPresentationAttribute(
        (DWORD)MF_SOURCE_READER_MEDIASOURCE, MF_PD_DURATION, &var);
    if (SUCCEEDED(hr) && var.vt == VT_UI8) {
        m_duration = (double)var.uhVal.QuadPart / 10000000.0;
    }
    PropVariantClear(&var);

    // Create compositor texture
    if (m_isNV12) {
        // NV12 texture (DEFAULT usage for GPU copy target)
        D3D11_TEXTURE2D_DESC texDesc = {};
        texDesc.Width = m_width;
        texDesc.Height = m_height;
        texDesc.MipLevels = 1;
        texDesc.ArraySize = 1;
        texDesc.Format = DXGI_FORMAT_NV12;
        texDesc.SampleDesc.Count = 1;
        texDesc.Usage = D3D11_USAGE_DEFAULT;
        texDesc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;

        hr = device->CreateTexture2D(&texDesc, nullptr, &m_compositorTex);
        if (FAILED(hr)) {
            fprintf(stderr, "[MFDecode] CreateTexture2D(NV12) failed: 0x%08X\n", (unsigned)hr);
            close();
            return false;
        }

        // Y plane SRV (R8_UNORM)
        D3D11_SHADER_RESOURCE_VIEW_DESC srvDescY = {};
        srvDescY.Format = DXGI_FORMAT_R8_UNORM;
        srvDescY.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2D;
        srvDescY.Texture2D.MipLevels = 1;
        srvDescY.Texture2D.MostDetailedMip = 0;

        hr = device->CreateShaderResourceView(m_compositorTex, &srvDescY, &m_srv);
        if (FAILED(hr)) {
            fprintf(stderr, "[MFDecode] CreateSRV(Y) failed: 0x%08X\n", (unsigned)hr);
            close();
            return false;
        }

        // UV plane SRV (R8G8_UNORM)
        D3D11_SHADER_RESOURCE_VIEW_DESC srvDescUV = {};
        srvDescUV.Format = DXGI_FORMAT_R8G8_UNORM;
        srvDescUV.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2D;
        srvDescUV.Texture2D.MipLevels = 1;
        srvDescUV.Texture2D.MostDetailedMip = 0;

        hr = device->CreateShaderResourceView(m_compositorTex, &srvDescUV, &m_srvUV);
        if (FAILED(hr)) {
            fprintf(stderr, "[MFDecode] CreateSRV(UV) failed: 0x%08X\n", (unsigned)hr);
            close();
            return false;
        }

        fprintf(stderr, "[MFDecode] NV12 texture %ux%u + Y SRV + UV SRV created\n", m_width, m_height);
    } else {
        // BGRA texture
        D3D11_TEXTURE2D_DESC texDesc = {};
        texDesc.Width = m_width;
        texDesc.Height = m_height;
        texDesc.MipLevels = 1;
        texDesc.ArraySize = 1;
        texDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        texDesc.SampleDesc.Count = 1;
        texDesc.Usage = m_dxvaEnabled ? D3D11_USAGE_DEFAULT : D3D11_USAGE_DYNAMIC;
        texDesc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        texDesc.CPUAccessFlags = m_dxvaEnabled ? 0 : D3D11_CPU_ACCESS_WRITE;

        hr = device->CreateTexture2D(&texDesc, nullptr, &m_compositorTex);
        if (FAILED(hr)) {
            fprintf(stderr, "[MFDecode] CreateTexture2D(BGRA) failed: 0x%08X\n", (unsigned)hr);
            close();
            return false;
        }

        hr = device->CreateShaderResourceView(m_compositorTex, nullptr, &m_srv);
        if (FAILED(hr)) {
            fprintf(stderr, "[MFDecode] CreateSRV(BGRA) failed: 0x%08X\n", (unsigned)hr);
            close();
            return false;
        }
    }

    m_opened = true;
    fprintf(stderr, "[MFDecode] Opened '%s' %ux%u, duration=%.2fs, path=%s, fmt=%s\n",
            path.c_str(), m_width, m_height, m_duration,
            m_dxvaEnabled ? "DXVA/GPU" : "CPU",
            m_isNV12 ? "NV12" : "BGRA");
    return true;
}

// ============================================================================
// openDXVA — DXGI device manager + GPU-accelerated reader, NV12 output
// ============================================================================
bool VideoDecoder::openDXVA(const wchar_t* wpath) {
    HRESULT hr = MFCreateDXGIDeviceManager(&m_resetToken, &m_dxgiManager);
    if (FAILED(hr)) {
        fprintf(stderr, "[MFDecode] MFCreateDXGIDeviceManager failed: 0x%08X\n", (unsigned)hr);
        return false;
    }

    hr = m_dxgiManager->ResetDevice(m_device, m_resetToken);
    if (FAILED(hr)) {
        fprintf(stderr, "[MFDecode] DXGI ResetDevice failed: 0x%08X\n", (unsigned)hr);
        return false;
    }

    fprintf(stderr, "[MFDecode] Using MF DXGI Device Manager (DXVA/GPU decode)\n");

    IMFAttributes* attrs = nullptr;
    hr = MFCreateAttributes(&attrs, 4);
    if (FAILED(hr)) return false;

    attrs->SetUnknown(MF_SOURCE_READER_D3D_MANAGER, m_dxgiManager);
    attrs->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE);
    attrs->SetUINT32(MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, TRUE);
    attrs->SetUINT32(MF_LOW_LATENCY, TRUE);

    hr = MFCreateSourceReaderFromURL(wpath, attrs, &m_reader);
    attrs->Release();

    if (FAILED(hr)) {
        fprintf(stderr, "[MFDecode] DXVA MFCreateSourceReaderFromURL failed: 0x%08X\n", (unsigned)hr);
        return false;
    }

    // Request NV12 output — native DXVA output, no conversion needed
    IMFMediaType* outputType = nullptr;
    hr = MFCreateMediaType(&outputType);
    if (FAILED(hr)) return false;

    outputType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    outputType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);

    hr = m_reader->SetCurrentMediaType(
        (DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, outputType);

    if (FAILED(hr)) {
        fprintf(stderr, "[MFDecode] NV12 output failed (0x%08X), trying ARGB32...\n", (unsigned)hr);
        // Fall back to ARGB32 with DXVA still active
        outputType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_ARGB32);
        hr = m_reader->SetCurrentMediaType(
            (DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, outputType);
    }
    outputType->Release();

    if (FAILED(hr)) {
        fprintf(stderr, "[MFDecode] DXVA output type failed: 0x%08X\n", (unsigned)hr);
        return false;
    }

    m_dxvaEnabled = true;
    return true;
}

// ============================================================================
// openCPU — fallback CPU decode path
// ============================================================================
bool VideoDecoder::openCPU(const wchar_t* wpath) {
    IMFAttributes* attrs = nullptr;
    HRESULT hr = MFCreateAttributes(&attrs, 2);
    if (SUCCEEDED(hr)) {
        attrs->SetUINT32(MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, TRUE);
        attrs->SetUINT32(MF_LOW_LATENCY, TRUE);
    }

    hr = MFCreateSourceReaderFromURL(wpath, attrs, &m_reader);
    if (attrs) attrs->Release();

    if (FAILED(hr)) {
        fprintf(stderr, "[MFDecode] CPU MFCreateSourceReaderFromURL failed: 0x%08X\n", (unsigned)hr);
        return false;
    }

    IMFMediaType* outputType = nullptr;
    hr = MFCreateMediaType(&outputType);
    if (FAILED(hr)) return false;

    outputType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    outputType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_ARGB32);

    hr = m_reader->SetCurrentMediaType(
        (DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, outputType);

    if (FAILED(hr)) {
        outputType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
        hr = m_reader->SetCurrentMediaType(
            (DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, outputType);
    }
    outputType->Release();

    if (FAILED(hr)) {
        fprintf(stderr, "[MFDecode] CPU SetCurrentMediaType failed: 0x%08X\n", (unsigned)hr);
        return false;
    }

    m_dxvaEnabled = false;
    m_isNV12 = false;
    return true;
}

// ============================================================================
// decodeFrame — dispatch
// ============================================================================
bool VideoDecoder::decodeFrame(double timeSec, ID3D11DeviceContext* ctx) {
    if (!m_opened || !m_reader || !ctx) return false;
    return m_dxvaEnabled ? decodeFrameDXVA(timeSec, ctx) : decodeFrameCPU(timeSec, ctx);
}

// ============================================================================
// decodeFrameDXVA — GPU decode: get D3D11 surface, CopySubresourceRegion
// ============================================================================
bool VideoDecoder::decodeFrameDXVA(double timeSec, ID3D11DeviceContext* ctx) {
    // Only seek if: first frame, backward jump, or large forward jump (>0.5s ahead of expected)
    bool needSeek = (m_lastDecodedTime < 0.0) ||
                    (timeSec < m_lastDecodedTime - 0.001) ||
                    (timeSec > m_lastDecodedTime + 0.5);

    if (needSeek) {
        LONGLONG seekPos = (LONGLONG)(timeSec * 10000000.0);
        if (seekPos < 0) seekPos = 0;

        PROPVARIANT seekVar;
        PropVariantInit(&seekVar);
        seekVar.vt = VT_I8;
        seekVar.hVal.QuadPart = seekPos;
        m_reader->SetCurrentPosition(GUID_NULL, seekVar);
        PropVariantClear(&seekVar);
    }

    DWORD flags = 0;
    LONGLONG timestamp = 0;
    IMFSample* sample = nullptr;

    HRESULT hr = m_reader->ReadSample(
        (DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM,
        0, nullptr, &flags, &timestamp, &sample);

    if (FAILED(hr) || !sample) {
        if (sample) sample->Release();
        return false;
    }

    IMFMediaBuffer* buffer = nullptr;
    hr = sample->GetBufferByIndex(0, &buffer);
    if (FAILED(hr)) {
        sample->Release();
        return false;
    }

    // Try DXGI buffer (GPU surface)
    IMFDXGIBuffer* dxgiBuffer = nullptr;
    hr = buffer->QueryInterface(__uuidof(IMFDXGIBuffer), (void**)&dxgiBuffer);

    if (SUCCEEDED(hr) && dxgiBuffer) {
        ID3D11Texture2D* decodedTex = nullptr;
        hr = dxgiBuffer->GetResource(__uuidof(ID3D11Texture2D), (void**)&decodedTex);

        if (SUCCEEDED(hr) && decodedTex) {
            UINT subIndex = 0;
            dxgiBuffer->GetSubresourceIndex(&subIndex);

            // GPU copy: decoded surface → compositor texture
            ctx->CopySubresourceRegion(
                m_compositorTex, 0, 0, 0, 0,
                decodedTex, subIndex, nullptr);

            decodedTex->Release();
        }

        dxgiBuffer->Release();
    } else {
        // Fallback: CPU copy for DXVA BGRA path
        BYTE* srcData = nullptr;
        DWORD srcLen = 0;
        hr = buffer->Lock(&srcData, nullptr, &srcLen);
        if (SUCCEEDED(hr) && srcData) {
            const UINT srcStride = m_width * 4;
            D3D11_BOX box = { 0, 0, 0, m_width, m_height, 1 };
            ctx->UpdateSubresource(m_compositorTex, 0, &box, srcData, srcStride, 0);
            buffer->Unlock();
        }
    }

    buffer->Release();
    sample->Release();
    m_lastDecodedTime = timeSec;
    return true;
}

// ============================================================================
// decodeFrameCPU — CPU decode with Map/Unmap (BGRA DYNAMIC texture)
// ============================================================================
bool VideoDecoder::decodeFrameCPU(double timeSec, ID3D11DeviceContext* ctx) {
    // Only seek if: first frame, backward jump, or large forward jump (>0.5s ahead of expected)
    bool needSeek = (m_lastDecodedTime < 0.0) ||
                    (timeSec < m_lastDecodedTime - 0.001) ||
                    (timeSec > m_lastDecodedTime + 0.5);

    if (needSeek) {
        LONGLONG seekPos = (LONGLONG)(timeSec * 10000000.0);
        if (seekPos < 0) seekPos = 0;

        PROPVARIANT seekVar;
        PropVariantInit(&seekVar);
        seekVar.vt = VT_I8;
        seekVar.hVal.QuadPart = seekPos;
        m_reader->SetCurrentPosition(GUID_NULL, seekVar);
        PropVariantClear(&seekVar);
    }

    DWORD flags = 0;
    LONGLONG timestamp = 0;
    IMFSample* sample = nullptr;

    HRESULT hr = m_reader->ReadSample(
        (DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM,
        0, nullptr, &flags, &timestamp, &sample);

    if (FAILED(hr) || !sample) {
        if (sample) sample->Release();
        return false;
    }

    IMFMediaBuffer* buffer = nullptr;
    hr = sample->ConvertToContiguousBuffer(&buffer);
    if (FAILED(hr)) {
        sample->Release();
        return false;
    }

    BYTE* srcData = nullptr;
    DWORD srcLen = 0;
    hr = buffer->Lock(&srcData, nullptr, &srcLen);
    if (FAILED(hr) || !srcData) {
        buffer->Release();
        sample->Release();
        return false;
    }

    D3D11_MAPPED_SUBRESOURCE mapped;
    hr = ctx->Map(m_compositorTex, 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped);
    if (SUCCEEDED(hr)) {
        const UINT srcStride = m_width * 4;
        const BYTE* src = srcData;
        BYTE* dst = (BYTE*)mapped.pData;
        for (UINT row = 0; row < m_height; row++) {
            memcpy(dst, src, srcStride);
            src += srcStride;
            dst += mapped.RowPitch;
        }
        ctx->Unmap(m_compositorTex, 0);
    }

    buffer->Unlock();
    buffer->Release();
    sample->Release();
    if (SUCCEEDED(hr)) m_lastDecodedTime = timeSec;
    return SUCCEEDED(hr);
}

// ============================================================================
// close
// ============================================================================
void VideoDecoder::close() {
    if (m_srvUV) { m_srvUV->Release(); m_srvUV = nullptr; }
    if (m_srv) { m_srv->Release(); m_srv = nullptr; }
    if (m_compositorTex) { m_compositorTex->Release(); m_compositorTex = nullptr; }
    if (m_reader) { m_reader->Release(); m_reader = nullptr; }
    if (m_dxgiManager) { m_dxgiManager->Release(); m_dxgiManager = nullptr; }
    m_device = nullptr;
    m_resetToken = 0;
    m_dxvaEnabled = false;
    m_isNV12 = false;
    m_width = m_height = 0;
    m_duration = 0.0;
    m_lastDecodedTime = -1.0;
    m_opened = false;
}

} // namespace nativeexporter
