#pragma once

#include <d3d11.h>
#include <dxgi.h>
#include <cstdint>
#include <string>

namespace nativeexporter {

bool initD3D11();
bool createRenderTarget(uint32_t width, uint32_t height);
void renderSyntheticFrame(uint32_t frameIdx, uint32_t totalFrames);
void renderSolidColor(float r, float g, float b, float a);
void shutdown();

ID3D11Device* getDevice();
ID3D11DeviceContext* getContext();
ID3D11Texture2D* getRenderTarget();
std::string getAdapterDescription();

} // namespace nativeexporter
