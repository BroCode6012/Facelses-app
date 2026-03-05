#include <napi.h>
#include "d3d11_device.h"
#include "nvenc_loader.h"
#include "nvenc_encoder.h"
#include "compositor.h"
#include "texture_loader.h"
#include "video_decoder_mf.h"
#include <d3d11_1.h>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cmath>
#include <string>

using namespace nativeexporter;

static std::atomic<bool> s_cancelled{false};

// ============================================================================
// probe() â†’ { ok, gpu, nvenc, d3d11, reason }
// ============================================================================
Napi::Value Probe(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);

    // 1. D3D11
    bool d3dOk = initD3D11();
    result.Set("d3d11", Napi::Boolean::New(env, d3dOk));

    if (d3dOk) {
        result.Set("gpu", Napi::String::New(env, getAdapterDescription()));
    }

    if (!d3dOk) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("nvenc", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "D3D11 device creation failed"));
        shutdown();
        return result;
    }

    // 2. NVENC DLL
    bool nvencOk = loadNvenc();
    if (!nvencOk) {
        DWORD lastErr = GetLastError();
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("nvenc", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env,
            "nvEncodeAPI64.dll not found (GetLastError=" + std::to_string(lastErr) + ")"));
        shutdown();
        return result;
    }

    // 3. Open session to verify H.264 support
    bool sessionOk = openSession(getDevice());
    if (!sessionOk) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("nvenc", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "NVENC session open failed: " + getLastError()));
        unloadNvenc();
        shutdown();
        return result;
    }

    // Session opened successfully â€” NVENC works
    result.Set("nvenc", Napi::Boolean::New(env, true));
    result.Set("ok", Napi::Boolean::New(env, true));

    // Cleanup probe resources
    closeSession();
    unloadNvenc();
    shutdown();

    return result;
}

// ============================================================================
// encode(opts) â†’ { ok, outputPath, frames, elapsed, fps, reason }
// opts: { width, height, fps, totalFrames, bitrate?, maxBitrate?, gop?,
//         bframes?, preset?, rc?, outputPath }
// ============================================================================
Napi::Value Encode(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);

    if (info.Length() < 1 || !info[0].IsObject()) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "Expected options object"));
        return result;
    }

    Napi::Object opts = info[0].As<Napi::Object>();

    // Parse required options
    if (!opts.Has("width") || !opts.Has("height") || !opts.Has("fps") ||
        !opts.Has("totalFrames") || !opts.Has("outputPath")) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "Missing required: width, height, fps, totalFrames, outputPath"));
        return result;
    }

    EncoderConfig cfg;
    cfg.width = opts.Get("width").As<Napi::Number>().Uint32Value();
    cfg.height = opts.Get("height").As<Napi::Number>().Uint32Value();
    cfg.fps = opts.Get("fps").As<Napi::Number>().Uint32Value();
    uint32_t totalFrames = opts.Get("totalFrames").As<Napi::Number>().Uint32Value();
    std::string outputPath = opts.Get("outputPath").As<Napi::String>().Utf8Value();

    // Optional overrides
    if (opts.Has("bitrate") && opts.Get("bitrate").IsNumber())
        cfg.bitrate = opts.Get("bitrate").As<Napi::Number>().Uint32Value();
    if (opts.Has("maxBitrate") && opts.Get("maxBitrate").IsNumber())
        cfg.maxBitrate = opts.Get("maxBitrate").As<Napi::Number>().Uint32Value();
    if (opts.Has("gop") && opts.Get("gop").IsNumber())
        cfg.gop = opts.Get("gop").As<Napi::Number>().Uint32Value();
    if (opts.Has("bframes") && opts.Get("bframes").IsNumber())
        cfg.bframes = opts.Get("bframes").As<Napi::Number>().Uint32Value();
    if (opts.Has("preset") && opts.Get("preset").IsNumber())
        cfg.preset = opts.Get("preset").As<Napi::Number>().Uint32Value();
    if (opts.Has("rc") && opts.Get("rc").IsString())
        cfg.rc = opts.Get("rc").As<Napi::String>().Utf8Value();

    s_cancelled.store(false);

    auto startTime = std::chrono::steady_clock::now();

    // 1. Init D3D11
    if (!initD3D11()) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "D3D11 init failed"));
        return result;
    }

    if (!createRenderTarget(cfg.width, cfg.height)) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "createRenderTarget failed"));
        shutdown();
        return result;
    }

    // 2. Load NVENC
    if (!loadNvenc()) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "NVENC load failed"));
        shutdown();
        return result;
    }

    // 3. Open session + configure
    if (!openSession(getDevice())) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "NVENC session failed: " + getLastError()));
        unloadNvenc();
        shutdown();
        return result;
    }

    if (!configure(cfg)) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "NVENC configure failed: " + getLastError()));
        closeSession();
        unloadNvenc();
        shutdown();
        return result;
    }

    // 4. Register render target texture
    if (!registerTexture(getRenderTarget())) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "registerTexture failed: " + getLastError()));
        closeSession();
        unloadNvenc();
        shutdown();
        return result;
    }

    // 5. Open output file
    FILE* outFile = fopen(outputPath.c_str(), "wb");
    if (!outFile) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "Cannot open output file: " + outputPath));
        closeSession();
        unloadNvenc();
        shutdown();
        return result;
    }

    // 6. Encode loop
    uint32_t framesEncoded = 0;
    bool encodeOk = true;

    for (uint32_t i = 0; i < totalFrames; i++) {
        if (s_cancelled.load()) {
            break;
        }

        // Render synthetic frame
        renderSyntheticFrame(i, totalFrames);

        // Encode
        if (!encodeFrame(outFile)) {
            encodeOk = false;
            break;
        }
        framesEncoded++;
    }

    // 7. Flush remaining B-frames
    if (encodeOk && !s_cancelled.load()) {
        flush(outFile);
    }

    fclose(outFile);

    auto endTime = std::chrono::steady_clock::now();
    double elapsed = std::chrono::duration<double>(endTime - startTime).count();
    double fps = elapsed > 0 ? framesEncoded / elapsed : 0;

    // 8. Cleanup
    closeSession();
    unloadNvenc();
    shutdown();

    if (!encodeOk) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "Encode failed: " + getLastError()));
        result.Set("frames", Napi::Number::New(env, framesEncoded));
        return result;
    }

    if (s_cancelled.load()) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "Cancelled"));
        result.Set("frames", Napi::Number::New(env, framesEncoded));
        return result;
    }

    result.Set("ok", Napi::Boolean::New(env, true));
    result.Set("outputPath", Napi::String::New(env, outputPath));
    result.Set("frames", Napi::Number::New(env, framesEncoded));
    result.Set("elapsed", Napi::Number::New(env, elapsed));
    result.Set("fps", Napi::Number::New(env, fps));

    return result;
}

// ============================================================================
// Phase 3F: Fast video path â€” bypass compositor
// ============================================================================

static bool isFastPathEligible(const RenderPlan& plan) {
    if (plan.layers.size() != 1) return false;
    const auto& L = plan.layers[0];
    if (L.type != "video") return false;
    if (L.opacity < 0.999f) return false;
    if (L.startFrame != 0) return false;
    if (L.endFrame != plan.totalFrames) return false;
    if (std::abs(L.rotationRad) > 0.001f) return false;
    if (std::abs(L.rotationRadEnd) > 0.001f) return false;
    if (std::abs(L.layerScale[0] - 1.0f) > 0.001f) return false;
    if (std::abs(L.layerScale[1] - 1.0f) > 0.001f) return false;
    if (std::abs(L.translatePx[0]) > 0.5f) return false;
    if (std::abs(L.translatePx[1]) > 0.5f) return false;
    if (L.mediaPath.empty()) return false;
    return true;
}

static bool exportFastVideo(
    const RenderPlan& plan,
    const EncoderConfig& cfg,
    const std::string& outputPath,
    uint32_t& framesEncoded,
    double& elapsed,
    std::string& errorOut)
{
    const auto& L = plan.layers[0];
    auto startTime = std::chrono::steady_clock::now();

    fprintf(stderr, "[NativeExport] FastVideoPath enabled\n");

    if (!initD3D11()) { errorOut = "D3D11 init failed"; return false; }

    mfStartup();
    VideoDecoder decoder;
    if (!decoder.open(getDevice(), L.mediaPath)) {
        errorOut = "Decoder open failed";
        mfShutdown(); shutdown(); return false;
    }

    if (!decoder.isNV12() || !decoder.isDXVA()) {
        fprintf(stderr, "[NativeExport] FastVideoPath: not NV12/DXVA, falling back\n");
        decoder.close(); mfShutdown(); shutdown(); return false;
    }

    fprintf(stderr, "[NativeExport] FastVideoPath: %ux%u decode -> %ux%u output\n",
            decoder.getWidth(), decoder.getHeight(), cfg.width, cfg.height);

    bool needsScale = (decoder.getWidth() != cfg.width || decoder.getHeight() != cfg.height);

    if (!loadNvenc()) { errorOut = "NVENC load"; decoder.close(); mfShutdown(); shutdown(); return false; }
    if (!openSession(getDevice())) { errorOut = getLastError(); unloadNvenc(); decoder.close(); mfShutdown(); shutdown(); return false; }
    if (!configure(cfg)) { errorOut = getLastError(); closeSession(); unloadNvenc(); decoder.close(); mfShutdown(); shutdown(); return false; }

    ID3D11Texture2D* encodeTex = nullptr;
    ID3D11VideoDevice* vd = nullptr;
    ID3D11VideoContext* vc = nullptr;
    ID3D11VideoProcessorEnumerator* vpE = nullptr;
    ID3D11VideoProcessor* vp = nullptr;
    ID3D11VideoProcessorInputView* vpIn = nullptr;
    ID3D11VideoProcessorOutputView* vpOut = nullptr;

    auto cleanupVP = [&]() {
        if (vpOut) vpOut->Release();
        if (vpIn) vpIn->Release();
        if (vp) vp->Release();
        if (vpE) vpE->Release();
        if (vc) vc->Release();
        if (vd) vd->Release();
        if (encodeTex) encodeTex->Release();
    };
    auto cleanupAll = [&]() {
        cleanupVP();
        closeSession(); unloadNvenc(); decoder.close(); mfShutdown(); shutdown();
    };

    if (needsScale) {
        D3D11_TEXTURE2D_DESC desc = {};
        desc.Width = cfg.width; desc.Height = cfg.height;
        desc.MipLevels = 1; desc.ArraySize = 1;
        desc.Format = DXGI_FORMAT_NV12;
        desc.SampleDesc.Count = 1;
        desc.Usage = D3D11_USAGE_DEFAULT;
        desc.BindFlags = D3D11_BIND_RENDER_TARGET;

        if (FAILED(getDevice()->CreateTexture2D(&desc, nullptr, &encodeTex))) {
            errorOut = "NV12 encode tex failed"; cleanupAll(); return false;
        }

        if (FAILED(getDevice()->QueryInterface(__uuidof(ID3D11VideoDevice), (void**)&vd)) ||
            FAILED(getContext()->QueryInterface(__uuidof(ID3D11VideoContext), (void**)&vc))) {
            errorOut = "VP QI failed"; cleanupAll(); return false;
        }

        D3D11_VIDEO_PROCESSOR_CONTENT_DESC vpDesc = {};
        vpDesc.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
        vpDesc.InputWidth = decoder.getWidth(); vpDesc.InputHeight = decoder.getHeight();
        vpDesc.OutputWidth = cfg.width; vpDesc.OutputHeight = cfg.height;
        vpDesc.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;

        if (FAILED(vd->CreateVideoProcessorEnumerator(&vpDesc, &vpE)) ||
            FAILED(vd->CreateVideoProcessor(vpE, 0, &vp))) {
            errorOut = "VP create failed"; cleanupAll(); return false;
        }

        D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC ivd = {};
        ivd.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
        if (FAILED(vd->CreateVideoProcessorInputView(decoder.getTexture(), vpE, &ivd, &vpIn))) {
            errorOut = "VP input view failed"; cleanupAll(); return false;
        }

        D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC ovd = {};
        ovd.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
        if (FAILED(vd->CreateVideoProcessorOutputView(encodeTex, vpE, &ovd, &vpOut))) {
            errorOut = "VP output view failed"; cleanupAll(); return false;
        }

        if (!registerTextureSlot(0, encodeTex, true)) {
            errorOut = "NVENC register NV12 failed"; cleanupAll(); return false;
        }
        fprintf(stderr, "[NativeExport] FastVideoPath: VP scale %ux%u -> %ux%u\n",
                decoder.getWidth(), decoder.getHeight(), cfg.width, cfg.height);
    } else {
        if (!registerTextureSlot(0, decoder.getTexture(), true)) {
            errorOut = "NVENC register NV12 failed"; cleanupAll(); return false;
        }
        fprintf(stderr, "[NativeExport] FastVideoPath: direct NV12 (no scale)\n");
    }

    FILE* outFile = fopen(outputPath.c_str(), "wb");
    if (!outFile) { errorOut = "Cannot open output"; cleanupAll(); return false; }

    framesEncoded = 0;
    bool encodeOk = true;
    double totalDecodeMs = 0, totalScaleMs = 0, totalEncodeMs = 0;
    float trimStart = L.trimStartSec;

    for (uint32_t i = 0; i < plan.totalFrames; i++) {
        if (s_cancelled.load()) break;
        double timeSec = trimStart + (double)i / plan.fps;

        auto t0 = std::chrono::steady_clock::now();
        if (!decoder.decodeFrame(timeSec, getContext())) { encodeOk = false; break; }
        auto t1 = std::chrono::steady_clock::now();

        if (needsScale) {
            D3D11_VIDEO_PROCESSOR_STREAM stream = {};
            stream.Enable = TRUE;
            stream.pInputSurface = vpIn;
            if (FAILED(vc->VideoProcessorBlt(vp, vpOut, 0, 1, &stream))) { encodeOk = false; break; }
        }
        auto t2 = std::chrono::steady_clock::now();

        if (!encodeFrameSlot(0, outFile)) { encodeOk = false; break; }
        auto t3 = std::chrono::steady_clock::now();

        totalDecodeMs += std::chrono::duration<double, std::milli>(t1 - t0).count();
        totalScaleMs += std::chrono::duration<double, std::milli>(t2 - t1).count();
        totalEncodeMs += std::chrono::duration<double, std::milli>(t3 - t2).count();
        framesEncoded++;
    }

    fprintf(stderr, "[NativeExport] FastVideoPath Timing: decode=%.1fms scale=%.1fms encode=%.1fms (%u frames)\n",
            totalDecodeMs, totalScaleMs, totalEncodeMs, framesEncoded);

    if (encodeOk && !s_cancelled.load()) flush(outFile);
    fclose(outFile);
    cleanupAll();

    auto endTime = std::chrono::steady_clock::now();
    elapsed = std::chrono::duration<double>(endTime - startTime).count();

    if (!encodeOk) { errorOut = "FastPath encode failed"; return false; }
    return true;
}

// ============================================================================
// composeAndEncode(opts) â†’ { ok, frames, elapsed, fps, reason }
// opts: { width, height, fps, totalFrames, outputPath, layers:[] }
// ============================================================================
Napi::Value ComposeAndEncode(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);

    if (info.Length() < 1 || !info[0].IsObject()) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "Expected options object"));
        return result;
    }

    Napi::Object opts = info[0].As<Napi::Object>();

    // Parse required fields
    if (!opts.Has("width") || !opts.Has("height") || !opts.Has("fps") ||
        !opts.Has("totalFrames") || !opts.Has("outputPath") || !opts.Has("layers")) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "Missing required: width, height, fps, totalFrames, outputPath, layers"));
        return result;
    }

    // Build RenderPlan from N-API objects
    RenderPlan plan;
    plan.width = opts.Get("width").As<Napi::Number>().Uint32Value();
    plan.height = opts.Get("height").As<Napi::Number>().Uint32Value();
    plan.fps = opts.Get("fps").As<Napi::Number>().Uint32Value();
    plan.totalFrames = opts.Get("totalFrames").As<Napi::Number>().Uint32Value();
    std::string outputPath = opts.Get("outputPath").As<Napi::String>().Utf8Value();

    // Parse layers
    Napi::Array layersArr = opts.Get("layers").As<Napi::Array>();
    for (uint32_t i = 0; i < layersArr.Length(); i++) {
        Napi::Object lObj = layersArr.Get(i).As<Napi::Object>();
        RenderLayer layer;
        layer.type = lObj.Get("type").As<Napi::String>().Utf8Value();
        layer.startFrame = lObj.Has("startFrame") ? lObj.Get("startFrame").As<Napi::Number>().Uint32Value() : 0;
        layer.endFrame = lObj.Has("endFrame") ? lObj.Get("endFrame").As<Napi::Number>().Uint32Value() : plan.totalFrames;
        layer.trackNum = lObj.Has("trackNum") ? lObj.Get("trackNum").As<Napi::Number>().Uint32Value() : 1;
        layer.opacity = lObj.Has("opacity") ? lObj.Get("opacity").As<Napi::Number>().FloatValue() : 1.0f;

        if (layer.type == "solid" && lObj.Has("color") && lObj.Get("color").IsArray()) {
            Napi::Array colorArr = lObj.Get("color").As<Napi::Array>();
            for (uint32_t c = 0; c < 4 && c < colorArr.Length(); c++) {
                layer.color[c] = colorArr.Get(c).As<Napi::Number>().FloatValue();
            }
        }
        if (layer.type == "image" || layer.type == "video") {
            if (lObj.Has("mediaPath") && lObj.Get("mediaPath").IsString())
                layer.mediaPath = lObj.Get("mediaPath").As<Napi::String>().Utf8Value();
            if (lObj.Has("fitMode") && lObj.Get("fitMode").IsString())
                layer.fitMode = lObj.Get("fitMode").As<Napi::String>().Utf8Value();
            else
                layer.fitMode = "cover";
            if (lObj.Has("trimStartSec") && lObj.Get("trimStartSec").IsNumber())
                layer.trimStartSec = lObj.Get("trimStartSec").As<Napi::Number>().FloatValue();
        }
        if (layer.type == "imageSequence") {
            if (lObj.Has("seqDir") && lObj.Get("seqDir").IsString())
                layer.seqDir = lObj.Get("seqDir").As<Napi::String>().Utf8Value();
            if (lObj.Has("seqPattern") && lObj.Get("seqPattern").IsString())
                layer.seqPattern = lObj.Get("seqPattern").As<Napi::String>().Utf8Value();
            if (lObj.Has("seqFrameCount") && lObj.Get("seqFrameCount").IsNumber())
                layer.seqFrameCount = lObj.Get("seqFrameCount").As<Napi::Number>().Uint32Value();
            if (lObj.Has("seqLocalStart") && lObj.Get("seqLocalStart").IsNumber())
                layer.seqLocalStart = lObj.Get("seqLocalStart").As<Napi::Number>().Uint32Value();
            if (lObj.Has("seqTileW") && lObj.Get("seqTileW").IsNumber())
                layer.seqTileW = lObj.Get("seqTileW").As<Napi::Number>().Uint32Value();
            if (lObj.Has("seqTileH") && lObj.Get("seqTileH").IsNumber())
                layer.seqTileH = lObj.Get("seqTileH").As<Napi::Number>().Uint32Value();
            if (lObj.Has("fitMode") && lObj.Get("fitMode").IsString())
                layer.fitMode = lObj.Get("fitMode").As<Napi::String>().Utf8Value();
            else
                layer.fitMode = "contain";
        }

        // Transform fields (Milestone C)
        auto getF = [&](const char* key, float def) -> float {
            return lObj.Has(key) && lObj.Get(key).IsNumber() ? lObj.Get(key).As<Napi::Number>().FloatValue() : def;
        };
        layer.translatePx[0] = getF("translateX", 0);
        layer.translatePx[1] = getF("translateY", 0);
        layer.translatePxEnd[0] = getF("translateXEnd", layer.translatePx[0]);
        layer.translatePxEnd[1] = getF("translateYEnd", layer.translatePx[1]);
        layer.layerScale[0] = getF("scaleX", 1);
        layer.layerScale[1] = getF("scaleY", 1);
        layer.layerScaleEnd[0] = getF("scaleXEnd", layer.layerScale[0]);
        layer.layerScaleEnd[1] = getF("scaleYEnd", layer.layerScale[1]);
        layer.rotationRad = getF("rotationRad", 0);
        layer.rotationRadEnd = getF("rotationRadEnd", layer.rotationRad);
        layer.anchor[0] = getF("anchorX", 0.5f);
        layer.anchor[1] = getF("anchorY", 0.5f);

        plan.layers.push_back(layer);
    }

    // Parse encoder config
    EncoderConfig cfg;
    cfg.width = plan.width;
    cfg.height = plan.height;
    cfg.fps = plan.fps;
    if (opts.Has("bitrate") && opts.Get("bitrate").IsNumber())
        cfg.bitrate = opts.Get("bitrate").As<Napi::Number>().Uint32Value();
    if (opts.Has("maxBitrate") && opts.Get("maxBitrate").IsNumber())
        cfg.maxBitrate = opts.Get("maxBitrate").As<Napi::Number>().Uint32Value();
    if (opts.Has("gop") && opts.Get("gop").IsNumber())
        cfg.gop = opts.Get("gop").As<Napi::Number>().Uint32Value();
    if (opts.Has("bframes") && opts.Get("bframes").IsNumber())
        cfg.bframes = opts.Get("bframes").As<Napi::Number>().Uint32Value();
    if (opts.Has("preset") && opts.Get("preset").IsNumber())
        cfg.preset = opts.Get("preset").As<Napi::Number>().Uint32Value();
    if (opts.Has("rc") && opts.Get("rc").IsString())
        cfg.rc = opts.Get("rc").As<Napi::String>().Utf8Value();
    if (opts.Has("speedPreset") && opts.Get("speedPreset").IsString())
        cfg.speedPreset = opts.Get("speedPreset").As<Napi::String>().Utf8Value();

    s_cancelled.store(false);
    auto startTime = std::chrono::steady_clock::now();

    // Phase 3F: Try fast video path (bypass compositor)
    if (isFastPathEligible(plan)) {
        uint32_t fastFrames = 0;
        double fastElapsed = 0;
        std::string fastError;
        if (exportFastVideo(plan, cfg, outputPath, fastFrames, fastElapsed, fastError)) {
            double fastFps = fastElapsed > 0 ? fastFrames / fastElapsed : 0;
            result.Set("ok", Napi::Boolean::New(env, true));
            result.Set("outputPath", Napi::String::New(env, outputPath));
            result.Set("frames", Napi::Number::New(env, fastFrames));
            result.Set("elapsed", Napi::Number::New(env, fastElapsed));
            result.Set("fps", Napi::Number::New(env, fastFps));
            result.Set("fastPath", Napi::Boolean::New(env, true));
            return result;
        }
        fprintf(stderr, "[NativeExport] FastVideoPath failed (%s), falling back to compositor\n",
                fastError.c_str());
    }

    // 1. Init D3D11
    if (!initD3D11()) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "D3D11 init failed"));
        return result;
    }

    if (!createRenderTarget(plan.width, plan.height)) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "createRenderTarget failed"));
        shutdown();
        return result;
    }

    // 2. Init compositor (compile HLSL shaders)
    if (!initCompositor(getDevice(), getContext())) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "Compositor init failed"));
        shutdown();
        return result;
    }

    // 2b. Load image textures
    if (!loadTextures(plan)) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "loadTextures failed"));
        shutdownCompositor();
        shutdown();
        return result;
    }

    // 2c. Load video decoders
    if (!loadVideoLayers(plan)) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "loadVideoLayers failed"));
        shutdownCompositor();
        shutdown();
        return result;
    }

    // 3. Init NVENC
    if (!loadNvenc()) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "NVENC load failed"));
        shutdownCompositor();
        shutdown();
        return result;
    }

    if (!openSession(getDevice())) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "NVENC session failed: " + getLastError()));
        unloadNvenc();
        shutdownCompositor();
        shutdown();
        return result;
    }

    if (!configure(cfg)) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "NVENC configure failed: " + getLastError()));
        closeSession();
        unloadNvenc();
        shutdownCompositor();
        shutdown();
        return result;
    }

    // 3b. Multi-inflight: create N BGRA render-target textures + RTVs + register with NVENC
    static const int INFLIGHT_SLOTS = 3;
    ID3D11Texture2D* slotTextures[MAX_INFLIGHT_SLOTS] = {};
    ID3D11RenderTargetView* slotRTVs[MAX_INFLIGHT_SLOTS] = {};
    int numSlots = 0;

    for (int s = 0; s < INFLIGHT_SLOTS; s++) {
        D3D11_TEXTURE2D_DESC desc = {};
        desc.Width = cfg.width;
        desc.Height = cfg.height;
        desc.MipLevels = 1;
        desc.ArraySize = 1;
        desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        desc.SampleDesc.Count = 1;
        desc.Usage = D3D11_USAGE_DEFAULT;
        desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;

        HRESULT hr = getDevice()->CreateTexture2D(&desc, nullptr, &slotTextures[s]);
        if (FAILED(hr)) {
            fprintf(stderr, "[NativeExport] Slot[%d] texture failed: 0x%08X\n", s, (unsigned)hr);
            break;
        }

        hr = getDevice()->CreateRenderTargetView(slotTextures[s], nullptr, &slotRTVs[s]);
        if (FAILED(hr)) {
            fprintf(stderr, "[NativeExport] Slot[%d] RTV failed: 0x%08X\n", s, (unsigned)hr);
            slotTextures[s]->Release(); slotTextures[s] = nullptr;
            break;
        }

        if (!registerTextureSlot(s, slotTextures[s], false)) {
            fprintf(stderr, "[NativeExport] registerTextureSlot[%d] failed: %s\n", s, getLastError().c_str());
            slotRTVs[s]->Release(); slotRTVs[s] = nullptr;
            slotTextures[s]->Release(); slotTextures[s] = nullptr;
            break;
        }

        numSlots++;
    }

    if (numSlots == 0) {
        // Fallback: single-slot using the main RT
        if (!registerTextureSlot(0, getRenderTarget(), false)) {
            result.Set("ok", Napi::Boolean::New(env, false));
            result.Set("reason", Napi::String::New(env, "registerTexture failed: " + getLastError()));
            closeSession();
            unloadNvenc();
            shutdownCompositor();
            shutdown();
            return result;
        }
        numSlots = 1;
        fprintf(stderr, "[NativeExport] Encode: single-slot fallback (main RT)\n");
    } else {
        fprintf(stderr, "[NativeExport] Encode: %d inflight slots (direct render, pre-registered)\n", numSlots);
    }

    // 4. Open output file
    FILE* outFile = fopen(outputPath.c_str(), "wb");
    if (!outFile) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "Cannot open output: " + outputPath));
        for (int s = 0; s < INFLIGHT_SLOTS; s++) {
            if (slotRTVs[s]) { slotRTVs[s]->Release(); }
            if (slotTextures[s]) { slotTextures[s]->Release(); }
        }
        closeSession();
        unloadNvenc();
        shutdownCompositor();
        shutdown();
        return result;
    }

    // 5. Render + encode loop (direct render to slot, zero copy)
    fprintf(stderr, "[NativeExport] Starting encode: %u frames, %d inflight slots (direct render)\n",
            plan.totalFrames, numSlots);
    uint32_t framesEncoded = 0;
    bool encodeOk = true;
    double totalDecodeMs = 0, totalRenderMs = 0, totalEncodeMs = 0;

    for (uint32_t i = 0; i < plan.totalFrames; i++) {
        if (s_cancelled.load()) break;

        int slot = (numSlots > 1) ? (int)(i % numSlots) : 0;

        // Pick this slot's RTV (or main RT if single-slot fallback)
        ID3D11RenderTargetView* rtv = (numSlots > 1 && slotRTVs[slot]) ? slotRTVs[slot] : getRTV();

        auto t0 = std::chrono::steady_clock::now();

        // Decode video frames + advance image sequences
        advanceVideoFrame(i, plan);
        advanceImageSequences(i, plan);

        auto t1 = std::chrono::steady_clock::now();

        // Render directly into slot's RT (no copy needed)
        renderFrame(i, plan, rtv, plan.width, plan.height);

        auto t2 = std::chrono::steady_clock::now();

        // NVENC encode from slot (already registered)
        if (!encodeFrameSlot(slot, outFile)) {
            encodeOk = false;
            break;
        }

        auto t3 = std::chrono::steady_clock::now();

        totalDecodeMs += std::chrono::duration<double, std::milli>(t1 - t0).count();
        totalRenderMs += std::chrono::duration<double, std::milli>(t2 - t1).count();
        totalEncodeMs += std::chrono::duration<double, std::milli>(t3 - t2).count();

        framesEncoded++;
    }

    fprintf(stderr, "[NativeExport] Timing: decode=%.1fms render=%.1fms encode=%.1fms (total per %u frames)\n",
            totalDecodeMs, totalRenderMs, totalEncodeMs, framesEncoded);


    // 6. Flush + cleanup
    if (encodeOk && !s_cancelled.load()) {
        flush(outFile);
    }
    fclose(outFile);

    auto endTime = std::chrono::steady_clock::now();
    double elapsed = std::chrono::duration<double>(endTime - startTime).count();
    double fpsOut = elapsed > 0 ? framesEncoded / elapsed : 0;

    // Clean up slot resources
    for (int s = 0; s < INFLIGHT_SLOTS; s++) {
        if (slotRTVs[s]) { slotRTVs[s]->Release(); slotRTVs[s] = nullptr; }
        if (slotTextures[s]) { slotTextures[s]->Release(); slotTextures[s] = nullptr; }
    }
    closeSession();
    unloadNvenc();
    shutdownCompositor();
    shutdown();

    if (!encodeOk) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "Encode failed: " + getLastError()));
        result.Set("frames", Napi::Number::New(env, framesEncoded));
        return result;
    }

    if (s_cancelled.load()) {
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("reason", Napi::String::New(env, "Cancelled"));
        result.Set("frames", Napi::Number::New(env, framesEncoded));
        return result;
    }

    result.Set("ok", Napi::Boolean::New(env, true));
    result.Set("outputPath", Napi::String::New(env, outputPath));
    result.Set("frames", Napi::Number::New(env, framesEncoded));
    result.Set("elapsed", Napi::Number::New(env, elapsed));
    result.Set("fps", Napi::Number::New(env, fpsOut));
    return result;
}

// ============================================================================
// cancel() â€” sets atomic flag to stop encode loop
// ============================================================================
Napi::Value Cancel(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    s_cancelled.store(true);
    Napi::Object result = Napi::Object::New(env);
    result.Set("ok", Napi::Boolean::New(env, true));
    return result;
}

// ============================================================================
// Module init
// ============================================================================
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("probe", Napi::Function::New(env, Probe));
    exports.Set("encode", Napi::Function::New(env, Encode));
    exports.Set("composeAndEncode", Napi::Function::New(env, ComposeAndEncode));
    exports.Set("cancel", Napi::Function::New(env, Cancel));
    return exports;
}

NODE_API_MODULE(native_exporter, Init)
