#pragma once

#include <d3d11.h>
#include <cstdint>
#include <string>

// Forward-declare MF types to avoid pulling mfidl.h into every TU
struct IMFSourceReader;
struct IMFDXGIDeviceManager;

namespace nativeexporter {

/**
 * VideoDecoder — decodes H.264/MP4 frames via Media Foundation.
 * Phase 3B2: DXVA GPU decode → NV12 D3D11 surfaces → dual SRV (Y+UV).
 * Falls back to CPU BGRA path if DXVA is unavailable.
 */
class VideoDecoder {
public:
    VideoDecoder();
    ~VideoDecoder();

    // Non-copyable
    VideoDecoder(const VideoDecoder&) = delete;
    VideoDecoder& operator=(const VideoDecoder&) = delete;

    // Move support (for vector storage)
    VideoDecoder(VideoDecoder&& other) noexcept;
    VideoDecoder& operator=(VideoDecoder&& other) noexcept;

    /// Open video file. Tries DXVA NV12 first, falls back to CPU BGRA.
    bool open(ID3D11Device* device, const std::string& path);

    /// Decode frame at given timestamp and update compositor texture.
    bool decodeFrame(double timeSec, ID3D11DeviceContext* ctx);

    /// SRV for BGRA texture (CPU path) or Y plane (NV12 path).
    ID3D11ShaderResourceView* getSRV() const { return m_srv; }

    /// SRV for UV plane (NV12 path only, nullptr for BGRA).
    ID3D11ShaderResourceView* getSRV_UV() const { return m_srvUV; }

    uint32_t getWidth() const { return m_width; }
    uint32_t getHeight() const { return m_height; }
    ID3D11Texture2D* getTexture() const { return m_compositorTex; }
    double getDuration() const { return m_duration; }
    bool isDXVA() const { return m_dxvaEnabled; }
    bool isNV12() const { return m_isNV12; }

    void close();

private:
    IMFSourceReader*            m_reader = nullptr;
    ID3D11Device*               m_device = nullptr;
    ID3D11Texture2D*            m_compositorTex = nullptr;  // BGRA or NV12
    ID3D11ShaderResourceView*   m_srv = nullptr;            // Y plane (NV12) or BGRA
    ID3D11ShaderResourceView*   m_srvUV = nullptr;          // UV plane (NV12 only)

    // DXVA fields
    IMFDXGIDeviceManager*       m_dxgiManager = nullptr;
    UINT                        m_resetToken = 0;
    bool                        m_dxvaEnabled = false;
    bool                        m_isNV12 = false;

    uint32_t                    m_width = 0;
    uint32_t                    m_height = 0;
    double                      m_duration = 0.0;
    double                      m_lastDecodedTime = -1.0;  // for sequential decode (skip seek)
    bool                        m_opened = false;

    bool openDXVA(const wchar_t* wpath);
    bool openCPU(const wchar_t* wpath);
    bool decodeFrameDXVA(double timeSec, ID3D11DeviceContext* ctx);
    bool decodeFrameCPU(double timeSec, ID3D11DeviceContext* ctx);
};

/// Call once at startup / shutdown (ref-counted internally).
void mfStartup();
void mfShutdown();

} // namespace nativeexporter
