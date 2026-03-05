#pragma once

#include "nvEncodeAPI.h"
#include <d3d11.h>
#include <cstdint>
#include <cstdio>
#include <string>

namespace nativeexporter {

static const int MAX_INFLIGHT_SLOTS = 4;

struct EncoderConfig {
    uint32_t width = 1920;
    uint32_t height = 1080;
    uint32_t fps = 30;
    uint32_t bitrate = 18000000;       // 18 Mbps target
    uint32_t maxBitrate = 24000000;    // 24 Mbps max (VBR)
    uint32_t gop = 60;                 // 2s at 30fps
    uint32_t bframes = 2;
    uint32_t preset = 5;               // P5 (1-7)
    std::string rc = "vbr_hq";         // vbr_hq, cbr_hq, cbr
    std::string speedPreset = "quality"; // "quality" or "fast"
};

bool openSession(ID3D11Device* device);
bool configure(const EncoderConfig& cfg);

// Single-slot (legacy, slot 0 only)
bool registerTexture(ID3D11Texture2D* texture);
bool registerTextureNV12(ID3D11Texture2D* texture);

// Multi-slot registration (Phase 3D)
bool registerTextureSlot(int slot, ID3D11Texture2D* texture, bool nv12);
int  getRegisteredSlotCount();

// Encode from specific slot
bool encodeFrame(FILE* outFile);              // legacy: uses slot 0
bool encodeFrameSlot(int slot, FILE* outFile); // multi-slot

bool flush(FILE* outFile);
void closeSession();
bool isSessionOpen();
std::string getLastError();
void setVerboseLogging(bool v);

} // namespace nativeexporter
