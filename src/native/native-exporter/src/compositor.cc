#include "compositor.h"
#include "texture_loader.h"
#include <d3dcompiler.h>
#include <cstdio>
#include <cstring>
#include <vector>
#include <cmath>

namespace nativeexporter {

// ============================================================================
// HLSL Shaders (embedded)
// ============================================================================

// Shared constant buffer layout (64 bytes = 4 x float4):
//   row0: solidColor.rgba  OR  fitScale.xy + fitOffset.xy
//   row1: opacity, rotationRad, anchorX, anchorY
//   row2: translateX, translateY, scaleX, scaleY      (pixels / factors)
//   row3: rtWidth, rtHeight, 0, 0

static const char* VS_QUAD = R"(
cbuffer CB : register(b0) {
    float4 u_row0;       // unused by VS
    float4 u_params;     // opacity, rotationRad, anchorX, anchorY
    float4 u_transform;  // translateX, translateY, scaleX, scaleY
    float4 u_rtInfo;     // rtWidth, rtHeight, 0, 0
};

struct VS_OUT {
    float4 pos : SV_POSITION;
    float2 uv  : TEXCOORD0;
};

// Quad from 6 vertices (2 triangles) via SV_VertexID — no vertex buffer.
VS_OUT main(uint id : SV_VertexID) {
    // Triangle 0: (0,0),(1,0),(0,1)  Triangle 1: (1,0),(1,1),(0,1)
    static const float2 QUAD[6] = {
        float2(0,0), float2(1,0), float2(0,1),
        float2(1,0), float2(1,1), float2(0,1)
    };

    VS_OUT o;
    float2 uv = QUAD[id];
    o.uv = uv;

    // Layer rect in pixel space (fullscreen)
    float2 posPixels = uv * u_rtInfo.xy;

    // Anchor in pixel space
    float2 anchorPx = u_params.zw * u_rtInfo.xy;

    // Center on anchor
    float2 p = posPixels - anchorPx;

    // Scale
    p *= u_transform.zw;

    // Rotate
    float cosR = cos(u_params.y);
    float sinR = sin(u_params.y);
    p = float2(p.x * cosR - p.y * sinR,
               p.x * sinR + p.y * cosR);

    // Translate + restore anchor
    p += anchorPx + u_transform.xy;

    // Pixel to NDC (Y-flip: top=+1, bottom=-1)
    o.pos = float4(p.x / u_rtInfo.x * 2.0 - 1.0,
                   1.0 - p.y / u_rtInfo.y * 2.0,
                   0, 1);

    return o;
}
)";

static const char* PS_SOLID_COLOR = R"(
cbuffer CB : register(b0) {
    float4 u_color;     // row0: RGBA
    float4 u_params;    // row1: opacity, ...
};

float4 main(float4 pos : SV_POSITION, float2 uv : TEXCOORD0) : SV_TARGET {
    return u_color * u_params.x;
}
)";

static const char* PS_BLIT = R"(
Texture2D    u_texture : register(t0);
SamplerState u_sampler : register(s0);

cbuffer CB : register(b0) {
    float4 u_fitTransform;  // row0: fitScaleX, fitScaleY, fitOffsetX, fitOffsetY
    float4 u_params;        // row1: opacity, ...
};

float4 main(float4 pos : SV_POSITION, float2 uv : TEXCOORD0) : SV_TARGET {
    // Apply fit-mode transform: inverse scale then offset
    float2 tc = (uv - 0.5) / u_fitTransform.xy + 0.5 - u_fitTransform.zw;

    // Out-of-bounds → transparent
    if (tc.x < 0.0 || tc.x > 1.0 || tc.y < 0.0 || tc.y > 1.0)
        return float4(0, 0, 0, 0);

    float4 c = u_texture.Sample(u_sampler, tc);
    // Input is premultiplied alpha; scale both color and alpha by opacity
    c *= u_params.x;
    return c;
}
)";

// Blit shader for straight-alpha content (PNG overlays from MG renderer)
// Converts straight alpha → premultiplied in shader before output
static const char* PS_BLIT_STRAIGHT = R"(
Texture2D    u_texture : register(t0);
SamplerState u_sampler : register(s0);

cbuffer CB : register(b0) {
    float4 u_fitTransform;  // fitScaleX, fitScaleY, fitOffsetX, fitOffsetY
    float4 u_params;        // opacity, ...
};

float4 main(float4 pos : SV_POSITION, float2 uv : TEXCOORD0) : SV_TARGET {
    float2 tc = (uv - 0.5) / u_fitTransform.xy + 0.5 - u_fitTransform.zw;

    if (tc.x < 0.0 || tc.x > 1.0 || tc.y < 0.0 || tc.y > 1.0)
        return float4(0, 0, 0, 0);

    float4 c = u_texture.Sample(u_sampler, tc);
    // Straight alpha → premultiplied: rgb *= alpha
    c.rgb *= c.a;
    // Apply opacity
    c *= u_params.x;
    return c;
}
)";

// NV12 → RGB conversion pixel shader (BT.709, limited range)
static const char* PS_BLIT_NV12 = R"(
Texture2D<float>  u_texY  : register(t0);
Texture2D<float2> u_texUV : register(t1);
SamplerState      u_sampler : register(s0);

cbuffer CB : register(b0) {
    float4 u_fitTransform;  // fitScaleX, fitScaleY, fitOffsetX, fitOffsetY
    float4 u_params;        // opacity, ...
};

float4 main(float4 pos : SV_POSITION, float2 uv : TEXCOORD0) : SV_TARGET {
    // Apply fit-mode transform
    float2 tc = (uv - 0.5) / u_fitTransform.xy + 0.5 - u_fitTransform.zw;

    if (tc.x < 0.0 || tc.x > 1.0 || tc.y < 0.0 || tc.y > 1.0)
        return float4(0, 0, 0, 0);

    float y  = u_texY.Sample(u_sampler, tc);
    float2 uvVal = u_texUV.Sample(u_sampler, tc);

    // BT.709, limited range (Y: 16-235, UV: 16-240)
    y = (y - 16.0 / 255.0) * (255.0 / (235.0 - 16.0));
    float cb = uvVal.x - 0.5;
    float cr = uvVal.y - 0.5;

    // BT.709 coefficients
    float r = y + 1.5748 * cr;
    float g = y - 0.1873 * cb - 0.4681 * cr;
    float b = y + 1.8556 * cb;

    float4 c = float4(saturate(r), saturate(g), saturate(b), 1.0);
    c *= u_params.x;  // opacity
    return c;
}
)";

// ============================================================================
// Static state
// ============================================================================

static ID3D11Device*            s_device = nullptr;
static ID3D11DeviceContext*     s_ctx    = nullptr;
static ID3D11VertexShader*      s_vs     = nullptr;
static ID3D11PixelShader*       s_psSolid = nullptr;
static ID3D11PixelShader*       s_psBlit  = nullptr;
static ID3D11PixelShader*       s_psBlitStraight = nullptr; // straight alpha (PNG overlays)
static ID3D11PixelShader*       s_psBlitNV12 = nullptr;
static ID3D11Buffer*            s_cbuffer = nullptr;
static ID3D11SamplerState*      s_sampler = nullptr;
static ID3D11BlendState*        s_blendOpaque = nullptr;  // track 1
static ID3D11BlendState*        s_blendAlpha  = nullptr;  // track 2-3 (premul)
static bool                     s_ready  = false;

// Texture cache (indexed by layerIndex)
static std::vector<LoadedTexture> s_textures;

// Video decoder cache (indexed by videoDecoderIndex)
static std::vector<VideoDecoder> s_videoDecoders;
static uint32_t s_planFps = 30; // cached for time→frame conversion

// Constant buffer data — 64 bytes, 16-byte aligned (4 x float4)
struct alignas(16) CBData {
    float row0[4];      // solid: RGBA color; image: fitScaleX, fitScaleY, fitOffsetX, fitOffsetY
    float opacity;      // row1.x
    float rotationRad;  // row1.y
    float anchorX;      // row1.z
    float anchorY;      // row1.w
    float translateX;   // row2.x (pixels)
    float translateY;   // row2.y (pixels)
    float scaleX;       // row2.z
    float scaleY;       // row2.w
    float rtWidth;      // row3.x
    float rtHeight;     // row3.y
    float _pad[2];      // row3.zw
};

// ============================================================================
// Helpers
// ============================================================================

static ID3DBlob* compileShader(const char* source, const char* target, const char* entryPoint) {
    ID3DBlob* blob = nullptr;
    ID3DBlob* errors = nullptr;

    HRESULT hr = D3DCompile(
        source, strlen(source),
        nullptr, nullptr, nullptr,
        entryPoint, target,
        D3DCOMPILE_OPTIMIZATION_LEVEL3, 0,
        &blob, &errors
    );

    if (FAILED(hr)) {
        if (errors) {
            fprintf(stderr, "[Compositor] Shader compile error: %s\n",
                    (const char*)errors->GetBufferPointer());
            errors->Release();
        }
        return nullptr;
    }
    if (errors) errors->Release();
    return blob;
}

static inline float lerp(float a, float b, float t) {
    return a + (b - a) * t;
}

// ============================================================================
// Public API
// ============================================================================

bool initCompositor(ID3D11Device* device, ID3D11DeviceContext* ctx) {
    if (s_ready) return true;
    if (!device || !ctx) return false;

    s_device = device;
    s_ctx = ctx;

    fprintf(stderr, "[Compositor] Compiling shaders...\n");

    // Vertex shader (quad with T*R*S transform)
    ID3DBlob* vsBlob = compileShader(VS_QUAD, "vs_5_0", "main");
    if (!vsBlob) return false;
    HRESULT hr = device->CreateVertexShader(
        vsBlob->GetBufferPointer(), vsBlob->GetBufferSize(), nullptr, &s_vs);
    vsBlob->Release();
    if (FAILED(hr)) {
        fprintf(stderr, "[Compositor] CreateVertexShader failed: 0x%08X\n", (unsigned)hr);
        return false;
    }

    // Pixel shader — solid color
    {
        ID3DBlob* blob = compileShader(PS_SOLID_COLOR, "ps_5_0", "main");
        if (!blob) { shutdownCompositor(); return false; }
        hr = device->CreatePixelShader(blob->GetBufferPointer(), blob->GetBufferSize(), nullptr, &s_psSolid);
        blob->Release();
        if (FAILED(hr)) { shutdownCompositor(); return false; }
    }

    // Pixel shader — blit (texture + opacity + fit-mode)
    {
        ID3DBlob* blob = compileShader(PS_BLIT, "ps_5_0", "main");
        if (!blob) { shutdownCompositor(); return false; }
        hr = device->CreatePixelShader(blob->GetBufferPointer(), blob->GetBufferSize(), nullptr, &s_psBlit);
        blob->Release();
        if (FAILED(hr)) { shutdownCompositor(); return false; }
    }

    // Pixel shader — blit straight alpha (for PNG overlays)
    {
        ID3DBlob* blob = compileShader(PS_BLIT_STRAIGHT, "ps_5_0", "main");
        if (!blob) { shutdownCompositor(); return false; }
        hr = device->CreatePixelShader(blob->GetBufferPointer(), blob->GetBufferSize(), nullptr, &s_psBlitStraight);
        blob->Release();
        if (FAILED(hr)) { shutdownCompositor(); return false; }
    }

    // Pixel shader — blit NV12 (Y+UV → RGB, BT.709)
    {
        ID3DBlob* blob = compileShader(PS_BLIT_NV12, "ps_5_0", "main");
        if (!blob) { shutdownCompositor(); return false; }
        hr = device->CreatePixelShader(blob->GetBufferPointer(), blob->GetBufferSize(), nullptr, &s_psBlitNV12);
        blob->Release();
        if (FAILED(hr)) { shutdownCompositor(); return false; }
    }

    // Constant buffer (64 bytes = CBData)
    {
        D3D11_BUFFER_DESC cbDesc = {};
        cbDesc.ByteWidth = sizeof(CBData);
        cbDesc.Usage = D3D11_USAGE_DYNAMIC;
        cbDesc.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
        cbDesc.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
        hr = device->CreateBuffer(&cbDesc, nullptr, &s_cbuffer);
        if (FAILED(hr)) { shutdownCompositor(); return false; }
    }

    // Sampler (LINEAR + CLAMP)
    {
        D3D11_SAMPLER_DESC sd = {};
        sd.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
        sd.AddressU = D3D11_TEXTURE_ADDRESS_CLAMP;
        sd.AddressV = D3D11_TEXTURE_ADDRESS_CLAMP;
        sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
        hr = device->CreateSamplerState(&sd, &s_sampler);
        if (FAILED(hr)) { shutdownCompositor(); return false; }
    }

    // Blend state — opaque (no blending, overwrite)
    {
        D3D11_BLEND_DESC bd = {};
        bd.RenderTarget[0].BlendEnable = FALSE;
        bd.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
        hr = device->CreateBlendState(&bd, &s_blendOpaque);
        if (FAILED(hr)) { shutdownCompositor(); return false; }
    }

    // Blend state — premultiplied alpha (Src=ONE, Dst=INV_SRC_ALPHA)
    {
        D3D11_BLEND_DESC bd = {};
        bd.RenderTarget[0].BlendEnable = TRUE;
        bd.RenderTarget[0].SrcBlend = D3D11_BLEND_ONE;
        bd.RenderTarget[0].DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
        bd.RenderTarget[0].BlendOp = D3D11_BLEND_OP_ADD;
        bd.RenderTarget[0].SrcBlendAlpha = D3D11_BLEND_ONE;
        bd.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
        bd.RenderTarget[0].BlendOpAlpha = D3D11_BLEND_OP_ADD;
        bd.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
        hr = device->CreateBlendState(&bd, &s_blendAlpha);
        if (FAILED(hr)) { shutdownCompositor(); return false; }
    }

    s_ready = true;
    fprintf(stderr, "[Compositor] Init OK (VS_Quad + PS_Solid + PS_Blit + transforms)\n");
    return true;
}

bool loadTextures(RenderPlan& plan) {
    // Release any previous textures
    for (auto& t : s_textures) releaseTexture(t);
    s_textures.clear();

    for (auto& layer : plan.layers) {
        if (layer.type == "image" && !layer.mediaPath.empty()) {
            LoadedTexture tex;
            if (loadImageWIC(s_device, layer.mediaPath, tex)) {
                layer.layerIndex = (int)s_textures.size();
                layer.mediaWidth = tex.width;
                layer.mediaHeight = tex.height;
                s_textures.push_back(tex);
            } else {
                fprintf(stderr, "[Compositor] WARNING: Failed to load '%s', skipping layer\n",
                        layer.mediaPath.c_str());
                layer.layerIndex = -1;
            }
        } else if (layer.type == "imageSequence" && !layer.seqDir.empty()) {
            // Build frame-0 path from seqDir + seqPattern
            char frameName[512];
            snprintf(frameName, sizeof(frameName), layer.seqPattern.c_str(), layer.seqLocalStart);
            std::string frame0Path = layer.seqDir + "/" + frameName;

            LoadedTexture tex;
            if (loadImageWIC(s_device, frame0Path, tex)) {
                layer.layerIndex = (int)s_textures.size();
                layer.seqTileW = tex.width;
                layer.seqTileH = tex.height;
                s_textures.push_back(tex);
                fprintf(stderr, "[Compositor] imageSequence: loaded frame0 '%s' %ux%u\n",
                        frame0Path.c_str(), tex.width, tex.height);
            } else {
                fprintf(stderr, "[Compositor] WARNING: Failed to load imageSequence frame0 '%s'\n",
                        frame0Path.c_str());
                layer.layerIndex = -1;
            }
        }
    }

    fprintf(stderr, "[Compositor] Loaded %zu image textures\n", s_textures.size());
    return true;
}

bool loadVideoLayers(RenderPlan& plan) {
    // Close any previous decoders
    s_videoDecoders.clear();
    s_planFps = plan.fps > 0 ? plan.fps : 30;

    mfStartup();

    for (auto& layer : plan.layers) {
        if (layer.type == "video" && !layer.mediaPath.empty()) {
            VideoDecoder dec;
            if (dec.open(s_device, layer.mediaPath)) {
                layer.videoDecoderIndex = (int)s_videoDecoders.size();
                layer.mediaWidth = dec.getWidth();
                layer.mediaHeight = dec.getHeight();
                s_videoDecoders.push_back(std::move(dec));
            } else {
                fprintf(stderr, "[Compositor] WARNING: Failed to open video '%s', skipping layer\n",
                        layer.mediaPath.c_str());
                layer.videoDecoderIndex = -1;
            }
        }
    }

    fprintf(stderr, "[Compositor] Opened %zu video decoders\n", s_videoDecoders.size());
    return true;
}

void advanceVideoFrame(uint32_t frameNum, const RenderPlan& plan) {
    if (!s_ctx || s_videoDecoders.empty()) return;

    for (const auto& layer : plan.layers) {
        if (layer.type != "video" || layer.videoDecoderIndex < 0) continue;
        if (frameNum < layer.startFrame || frameNum >= layer.endFrame) continue;

        int idx = layer.videoDecoderIndex;
        if (idx >= (int)s_videoDecoders.size()) continue;

        // Compute time within the video: trimStartSec + offset from layer start
        double layerTimeSec = (double)layer.trimStartSec + (double)(frameNum - layer.startFrame) / (double)s_planFps;
        s_videoDecoders[idx].decodeFrame(layerTimeSec, s_ctx);
    }
}

void advanceImageSequences(uint32_t frameNum, const RenderPlan& plan) {
    if (!s_ctx || s_textures.empty()) return;

    static int s_lastMissingLog = -1; // avoid spamming logs for same missing frame
    static bool s_firstOverlayLogged = false;

    for (const auto& layer : plan.layers) {
        if (layer.type != "imageSequence" || layer.layerIndex < 0) continue;
        if (frameNum < layer.startFrame || frameNum >= layer.endFrame) continue;
        if (layer.layerIndex >= (int)s_textures.size()) continue;

        // Compute local frame number
        uint32_t localFrame = (frameNum - layer.startFrame) + layer.seqLocalStart;
        if (localFrame >= layer.seqFrameCount) localFrame = layer.seqFrameCount - 1;

        // Build path: seqDir / sprintf(seqPattern, localFrame)
        char frameName[512];
        snprintf(frameName, sizeof(frameName), layer.seqPattern.c_str(), localFrame);
        std::string framePath = layer.seqDir + "/" + frameName;

        // Diagnostic: log first overlay every 30 frames
        if (!s_firstOverlayLogged || (frameNum % 30 == 0)) {
            fprintf(stderr, "[Compositor] imgSeq[%d] frame=%u local=%u path='%s' tex=%ux%u\n",
                    layer.layerIndex, frameNum, localFrame, framePath.c_str(),
                    s_textures[layer.layerIndex].width, s_textures[layer.layerIndex].height);
            s_firstOverlayLogged = true;
        }

        LoadedTexture& tex = s_textures[layer.layerIndex];
        if (!updateTextureWIC(s_ctx, framePath, tex.texture, tex.width, tex.height)) {
            // Log once per missing frame, keep last uploaded frame
            if ((int)localFrame != s_lastMissingLog) {
                fprintf(stderr, "[Compositor] imageSequence: missing frame '%s', keeping last\n",
                        framePath.c_str());
                s_lastMissingLog = (int)localFrame;
            }
        }
    }
}

void renderFrame(uint32_t frameNum, const RenderPlan& plan,
                 ID3D11RenderTargetView* rtv, uint32_t width, uint32_t height) {
    if (!s_ready || !rtv) return;

    // 1. Clear to black
    float black[4] = { 0.0f, 0.0f, 0.0f, 1.0f };
    s_ctx->ClearRenderTargetView(rtv, black);

    // 2. Set render target + viewport
    s_ctx->OMSetRenderTargets(1, &rtv, nullptr);

    D3D11_VIEWPORT vp = {};
    vp.Width = (float)width;
    vp.Height = (float)height;
    vp.MinDepth = 0.0f;
    vp.MaxDepth = 1.0f;
    s_ctx->RSSetViewports(1, &vp);

    // 3. Set shared state
    s_ctx->IASetInputLayout(nullptr);
    s_ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    s_ctx->VSSetShader(s_vs, nullptr, 0);

    float blendFactor[4] = { 0, 0, 0, 0 };

    // 4. Draw active layers
    for (const auto& layer : plan.layers) {
        if (frameNum < layer.startFrame || frameNum >= layer.endFrame) continue;

        // Compute animation progress [0..1]
        float duration = (float)(layer.endFrame - layer.startFrame);
        float t = duration > 0.0f ? (float)(frameNum - layer.startFrame) / duration : 0.0f;

        // Interpolate transform values
        float tx = lerp(layer.translatePx[0], layer.translatePxEnd[0], t);
        float ty = lerp(layer.translatePx[1], layer.translatePxEnd[1], t);
        float sx = lerp(layer.layerScale[0], layer.layerScaleEnd[0], t);
        float sy = lerp(layer.layerScale[1], layer.layerScaleEnd[1], t);
        float rot = lerp(layer.rotationRad, layer.rotationRadEnd, t);

        // Set blend state: track 1 = opaque, track 2+ = premultiplied alpha
        if (layer.trackNum <= 1) {
            s_ctx->OMSetBlendState(s_blendOpaque, blendFactor, 0xFFFFFFFF);
        } else {
            s_ctx->OMSetBlendState(s_blendAlpha, blendFactor, 0xFFFFFFFF);
        }

        // VS needs the CB too — bind to VS slot 0
        s_ctx->VSSetConstantBuffers(0, 1, &s_cbuffer);

        if (layer.type == "solid") {
            // Update CB with solid color + transform
            D3D11_MAPPED_SUBRESOURCE mapped;
            HRESULT hr = s_ctx->Map(s_cbuffer, 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped);
            if (SUCCEEDED(hr)) {
                CBData* cb = (CBData*)mapped.pData;
                cb->row0[0] = layer.color[0];
                cb->row0[1] = layer.color[1];
                cb->row0[2] = layer.color[2];
                cb->row0[3] = layer.color[3];
                cb->opacity = layer.opacity;
                cb->rotationRad = rot;
                cb->anchorX = layer.anchor[0];
                cb->anchorY = layer.anchor[1];
                cb->translateX = tx;
                cb->translateY = ty;
                cb->scaleX = sx;
                cb->scaleY = sy;
                cb->rtWidth = (float)width;
                cb->rtHeight = (float)height;
                cb->_pad[0] = 0.0f;
                cb->_pad[1] = 0.0f;
                s_ctx->Unmap(s_cbuffer, 0);
            }

            s_ctx->PSSetShader(s_psSolid, nullptr, 0);
            s_ctx->PSSetConstantBuffers(0, 1, &s_cbuffer);
            s_ctx->Draw(6, 0);

        } else if (layer.type == "image" && layer.layerIndex >= 0 &&
                   layer.layerIndex < (int)s_textures.size()) {

            const LoadedTexture& tex = s_textures[layer.layerIndex];

            // Compute fit-mode transform (cover/contain)
            float srcAspect = (float)tex.width / (float)tex.height;
            float dstAspect = (float)width / (float)height;
            float fitScaleX = 1.0f, fitScaleY = 1.0f;

            if (layer.fitMode == "contain") {
                if (srcAspect > dstAspect) {
                    fitScaleY = dstAspect / srcAspect;
                } else {
                    fitScaleX = srcAspect / dstAspect;
                }
            } else {
                // Cover (default)
                if (srcAspect > dstAspect) {
                    fitScaleX = srcAspect / dstAspect;
                } else {
                    fitScaleY = dstAspect / srcAspect;
                }
            }

            // Update CB
            D3D11_MAPPED_SUBRESOURCE mapped;
            HRESULT hr = s_ctx->Map(s_cbuffer, 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped);
            if (SUCCEEDED(hr)) {
                CBData* cb = (CBData*)mapped.pData;
                cb->row0[0] = fitScaleX;
                cb->row0[1] = fitScaleY;
                cb->row0[2] = 0.0f;  // fitOffsetX
                cb->row0[3] = 0.0f;  // fitOffsetY
                cb->opacity = layer.opacity;
                cb->rotationRad = rot;
                cb->anchorX = layer.anchor[0];
                cb->anchorY = layer.anchor[1];
                cb->translateX = tx;
                cb->translateY = ty;
                cb->scaleX = sx;
                cb->scaleY = sy;
                cb->rtWidth = (float)width;
                cb->rtHeight = (float)height;
                cb->_pad[0] = 0.0f;
                cb->_pad[1] = 0.0f;
                s_ctx->Unmap(s_cbuffer, 0);
            }

            s_ctx->PSSetShader(s_psBlit, nullptr, 0);
            s_ctx->PSSetConstantBuffers(0, 1, &s_cbuffer);
            s_ctx->PSSetShaderResources(0, 1, &tex.srv);
            s_ctx->PSSetSamplers(0, 1, &s_sampler);
            s_ctx->Draw(6, 0);

            // Unbind SRV to avoid hazards
            ID3D11ShaderResourceView* nullSRV = nullptr;
            s_ctx->PSSetShaderResources(0, 1, &nullSRV);

        } else if (layer.type == "video" && layer.videoDecoderIndex >= 0 &&
                   layer.videoDecoderIndex < (int)s_videoDecoders.size()) {

            VideoDecoder& dec = s_videoDecoders[layer.videoDecoderIndex];
            ID3D11ShaderResourceView* videoSRV = dec.getSRV();
            if (!videoSRV) continue;

            // Compute fit-mode transform (cover/contain) using video dimensions
            float srcAspect = (float)dec.getWidth() / (float)dec.getHeight();
            float dstAspect = (float)width / (float)height;
            float fitScaleX = 1.0f, fitScaleY = 1.0f;

            if (layer.fitMode == "contain") {
                if (srcAspect > dstAspect) {
                    fitScaleY = dstAspect / srcAspect;
                } else {
                    fitScaleX = srcAspect / dstAspect;
                }
            } else {
                if (srcAspect > dstAspect) {
                    fitScaleX = srcAspect / dstAspect;
                } else {
                    fitScaleY = dstAspect / srcAspect;
                }
            }

            // Update CB (same layout as image blit)
            D3D11_MAPPED_SUBRESOURCE mapped;
            HRESULT hr = s_ctx->Map(s_cbuffer, 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped);
            if (SUCCEEDED(hr)) {
                CBData* cb = (CBData*)mapped.pData;
                cb->row0[0] = fitScaleX;
                cb->row0[1] = fitScaleY;
                cb->row0[2] = 0.0f;
                cb->row0[3] = 0.0f;
                cb->opacity = layer.opacity;
                cb->rotationRad = rot;
                cb->anchorX = layer.anchor[0];
                cb->anchorY = layer.anchor[1];
                cb->translateX = tx;
                cb->translateY = ty;
                cb->scaleX = sx;
                cb->scaleY = sy;
                cb->rtWidth = (float)width;
                cb->rtHeight = (float)height;
                cb->_pad[0] = 0.0f;
                cb->_pad[1] = 0.0f;
                s_ctx->Unmap(s_cbuffer, 0);
            }

            s_ctx->PSSetConstantBuffers(0, 1, &s_cbuffer);

            if (dec.isNV12()) {
                // NV12 path: bind Y + UV SRVs, use NV12 shader
                ID3D11ShaderResourceView* srvs[2] = { dec.getSRV(), dec.getSRV_UV() };
                s_ctx->PSSetShader(s_psBlitNV12, nullptr, 0);
                s_ctx->PSSetShaderResources(0, 2, srvs);
            } else {
                // BGRA path: single SRV, standard blit shader
                s_ctx->PSSetShader(s_psBlit, nullptr, 0);
                s_ctx->PSSetShaderResources(0, 1, &videoSRV);
            }

            s_ctx->PSSetSamplers(0, 1, &s_sampler);
            s_ctx->Draw(6, 0);

            // Unbind SRVs (2 slots for NV12 safety)
            ID3D11ShaderResourceView* nullSRVs[2] = { nullptr, nullptr };
            s_ctx->PSSetShaderResources(0, 2, nullSRVs);

        } else if (layer.type == "imageSequence" && layer.layerIndex >= 0 &&
                   layer.layerIndex < (int)s_textures.size()) {

            const LoadedTexture& tex = s_textures[layer.layerIndex];

            // Compute fit-mode using tile dimensions vs render target
            float srcAspect = (float)tex.width / (float)tex.height;
            float dstAspect = (float)width / (float)height;
            float fitScaleX = 1.0f, fitScaleY = 1.0f;

            if (layer.fitMode == "contain") {
                if (srcAspect > dstAspect) {
                    fitScaleY = dstAspect / srcAspect;
                } else {
                    fitScaleX = srcAspect / dstAspect;
                }
            } else {
                // Cover (default)
                if (srcAspect > dstAspect) {
                    fitScaleX = srcAspect / dstAspect;
                } else {
                    fitScaleY = dstAspect / srcAspect;
                }
            }

            // Update CB
            D3D11_MAPPED_SUBRESOURCE mapped;
            HRESULT hr = s_ctx->Map(s_cbuffer, 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped);
            if (SUCCEEDED(hr)) {
                CBData* cb = (CBData*)mapped.pData;
                cb->row0[0] = fitScaleX;
                cb->row0[1] = fitScaleY;
                cb->row0[2] = 0.0f;
                cb->row0[3] = 0.0f;
                cb->opacity = layer.opacity;
                cb->rotationRad = rot;
                cb->anchorX = layer.anchor[0];
                cb->anchorY = layer.anchor[1];
                cb->translateX = tx;
                cb->translateY = ty;
                cb->scaleX = sx;
                cb->scaleY = sy;
                cb->rtWidth = (float)width;
                cb->rtHeight = (float)height;
                cb->_pad[0] = 0.0f;
                cb->_pad[1] = 0.0f;
                s_ctx->Unmap(s_cbuffer, 0);
            }

            // Use straight-alpha shader for PNG overlays (not premultiplied)
            s_ctx->PSSetShader(s_psBlitStraight, nullptr, 0);
            s_ctx->PSSetConstantBuffers(0, 1, &s_cbuffer);
            s_ctx->PSSetShaderResources(0, 1, &tex.srv);
            s_ctx->PSSetSamplers(0, 1, &s_sampler);
            s_ctx->Draw(6, 0);

            // Unbind SRV
            ID3D11ShaderResourceView* nullSRV = nullptr;
            s_ctx->PSSetShaderResources(0, 1, &nullSRV);
        }
    }

    // Reset blend state
    s_ctx->OMSetBlendState(nullptr, blendFactor, 0xFFFFFFFF);
    s_ctx->Flush();
}

void shutdownCompositor() {
    // Close video decoders
    bool hadVideoDecoders = !s_videoDecoders.empty();
    s_videoDecoders.clear();
    if (hadVideoDecoders) mfShutdown();

    for (auto& t : s_textures) releaseTexture(t);
    s_textures.clear();

    if (s_blendAlpha)  { s_blendAlpha->Release();  s_blendAlpha = nullptr; }
    if (s_blendOpaque) { s_blendOpaque->Release(); s_blendOpaque = nullptr; }
    if (s_sampler)     { s_sampler->Release();     s_sampler = nullptr; }
    if (s_cbuffer)     { s_cbuffer->Release();     s_cbuffer = nullptr; }
    if (s_psBlitNV12)    { s_psBlitNV12->Release();    s_psBlitNV12 = nullptr; }
    if (s_psBlitStraight){ s_psBlitStraight->Release();s_psBlitStraight = nullptr; }
    if (s_psBlit)        { s_psBlit->Release();        s_psBlit = nullptr; }
    if (s_psSolid)     { s_psSolid->Release();     s_psSolid = nullptr; }
    if (s_vs)          { s_vs->Release();          s_vs = nullptr; }
    s_device = nullptr;
    s_ctx = nullptr;
    s_ready = false;
    fprintf(stderr, "[Compositor] Shutdown\n");
}

} // namespace nativeexporter
