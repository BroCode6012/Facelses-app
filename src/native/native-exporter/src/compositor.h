#pragma once

#include <d3d11.h>
#include <cstdint>
#include <string>
#include <vector>
#include "video_decoder_mf.h"

namespace nativeexporter {

struct RenderLayer {
    std::string type;         // "solid" or "image"
    float color[4] = {0,0,0,1}; // RGBA for solid
    uint32_t startFrame = 0;
    uint32_t endFrame = 0;
    uint32_t trackNum = 1;    // 1=base(opaque), 2-3=alpha blend
    float opacity = 1.0f;
    // Image layer fields
    std::string mediaPath;    // filesystem path to PNG/JPEG
    std::string fitMode;      // "cover" or "contain"
    uint32_t mediaWidth = 0;
    uint32_t mediaHeight = 0;
    int layerIndex = -1;      // index into texture cache (images)
    int videoDecoderIndex = -1; // index into video decoder cache
    // Transform fields (Milestone C)
    float translatePx[2] = {0, 0};       // start translate (pixels)
    float translatePxEnd[2] = {0, 0};    // end translate (lerp if != start)
    float layerScale[2] = {1, 1};        // start scale
    float layerScaleEnd[2] = {1, 1};     // end scale
    float rotationRad = 0.0f;            // start rotation (radians)
    float rotationRadEnd = 0.0f;         // end rotation
    float anchor[2] = {0.5f, 0.5f};     // anchor point [0..1]
    float trimStartSec = 0.0f;           // video trim offset (seconds into source)
    // imageSequence layer fields (Phase 4C)
    std::string seqDir;              // directory containing frame PNGs
    std::string seqPattern;          // printf pattern e.g. "frame_%06d.png"
    uint32_t seqFrameCount = 0;      // total frames in sequence
    uint32_t seqLocalStart = 0;      // local numbering offset (default 0)
    uint32_t seqTileW = 0;           // overlay texture width
    uint32_t seqTileH = 0;           // overlay texture height
};

struct RenderPlan {
    uint32_t width = 1920;
    uint32_t height = 1080;
    uint32_t fps = 30;
    uint32_t totalFrames = 0;
    std::vector<RenderLayer> layers;
};

bool initCompositor(ID3D11Device* device, ID3D11DeviceContext* ctx);
bool loadTextures(RenderPlan& plan);  // loads image layers, sets layerIndex
bool loadVideoLayers(RenderPlan& plan); // opens video decoders, sets videoDecoderIndex
void advanceVideoFrame(uint32_t frameNum, const RenderPlan& plan); // decode current video frames
void advanceImageSequences(uint32_t frameNum, const RenderPlan& plan); // load PNG for current frame
void renderFrame(uint32_t frameNum, const RenderPlan& plan,
                 ID3D11RenderTargetView* rtv, uint32_t width, uint32_t height);
void shutdownCompositor();

} // namespace nativeexporter
