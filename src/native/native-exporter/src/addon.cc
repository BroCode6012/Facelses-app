#include <napi.h>
#include "d3d11_device.h"
#include "nvenc_loader.h"
#include "nvenc_encoder.h"
#include <atomic>
#include <chrono>
#include <cstdio>
#include <string>

using namespace nativeexporter;

static std::atomic<bool> s_cancelled{false};

// ============================================================================
// probe() → { ok, gpu, nvenc, d3d11, reason }
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

    // Session opened successfully — NVENC works
    result.Set("nvenc", Napi::Boolean::New(env, true));
    result.Set("ok", Napi::Boolean::New(env, true));

    // Cleanup probe resources
    closeSession();
    unloadNvenc();
    shutdown();

    return result;
}

// ============================================================================
// encode(opts) → { ok, outputPath, frames, elapsed, fps, reason }
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
// cancel() — sets atomic flag to stop encode loop
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
    exports.Set("cancel", Napi::Function::New(env, Cancel));
    return exports;
}

NODE_API_MODULE(native_exporter, Init)
