#include "nvenc_encoder.h"
#include "nvenc_loader.h"
#include <cstring>
#include <cstdio>

namespace nativeexporter {

static void* s_encoder = nullptr; // NVENC encoder handle
static NV_ENC_REGISTERED_PTR s_registeredResource = nullptr;
static NV_ENC_OUTPUT_PTR s_bitstreamBuffer = nullptr;
static std::string s_lastError;
static EncoderConfig s_config;

static const char* nvencStatusStr(NVENCSTATUS s) {
    switch (s) {
        case 0: return "SUCCESS";
        case 1: return "NO_ENCODE_DEVICE";
        case 2: return "UNSUPPORTED_DEVICE";
        case 3: return "INVALID_ENCODERDEVICE";
        case 4: return "INVALID_DEVICE";
        case 5: return "DEVICE_NOT_EXIST";
        case 6: return "INVALID_PTR";
        case 7: return "INVALID_EVENT";
        case 8: return "INVALID_PARAM";
        case 9: return "INVALID_CALL";
        case 10: return "OUT_OF_MEMORY";
        case 11: return "ENCODER_NOT_INITIALIZED";
        case 12: return "UNSUPPORTED_PARAM";
        case 15: return "INVALID_VERSION";
        default: return "UNKNOWN";
    }
}

static const GUID& getPresetGuid(uint32_t preset) {
    switch (preset) {
        case 1: return NV_ENC_PRESET_P1_GUID;
        case 2: return NV_ENC_PRESET_P2_GUID;
        case 3: return NV_ENC_PRESET_P3_GUID;
        case 4: return NV_ENC_PRESET_P4_GUID;
        case 5: return NV_ENC_PRESET_P5_GUID;
        case 6: return NV_ENC_PRESET_P6_GUID;
        case 7: return NV_ENC_PRESET_P7_GUID;
        default: return NV_ENC_PRESET_P5_GUID;
    }
}

static NV_ENC_PARAMS_RC_MODE getRcMode(const std::string& rc) {
    if (rc == "cbr") return NV_ENC_PARAMS_RC_CBR;
    if (rc == "cbr_hq") return NV_ENC_PARAMS_RC_CBR_HQ;
    return NV_ENC_PARAMS_RC_VBR_HQ; // default
}

bool openSession(ID3D11Device* device) {
    if (s_encoder) return true;
    if (!device) { s_lastError = "No D3D11 device"; return false; }

    auto* fn = getNvencFunctions();
    if (!fn) {
        s_lastError = "NVENC function list is null";
        return false;
    }

    // Check critical function pointers
    fprintf(stderr, "[NVENC] === Function Pointer Check ===\n");
    fprintf(stderr, "[NVENC]   nvEncOpenEncodeSession:   %p\n", (void*)fn->nvEncOpenEncodeSession);
    fprintf(stderr, "[NVENC]   nvEncOpenEncodeSessionEx: %p\n", (void*)fn->nvEncOpenEncodeSessionEx);
    fprintf(stderr, "[NVENC]   nvEncGetEncodeGUIDCount:  %p\n", (void*)fn->nvEncGetEncodeGUIDCount);
    fprintf(stderr, "[NVENC]   nvEncInitializeEncoder:   %p\n", (void*)fn->nvEncInitializeEncoder);
    fprintf(stderr, "[NVENC]   nvEncEncodePicture:       %p\n", (void*)fn->nvEncEncodePicture);
    fprintf(stderr, "[NVENC]   nvEncDestroyEncoder:      %p\n", (void*)fn->nvEncDestroyEncoder);
    fprintf(stderr, "[NVENC]   nvEncRegisterResource:    %p\n", (void*)fn->nvEncRegisterResource);

    if (!fn->nvEncOpenEncodeSessionEx) {
        s_lastError = "nvEncOpenEncodeSessionEx function pointer is null";
        return false;
    }

    // Build session params
    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS params = {};
    params.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
    params.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
    params.device = device;
    params.apiVersion = NVENCAPI_VERSION;

    fprintf(stderr, "[NVENC] === OpenEncodeSessionEx ===\n");
    fprintf(stderr, "[NVENC]   version=0x%08X\n", params.version);
    fprintf(stderr, "[NVENC]   deviceType=%d (0=DIRECTX, 1=CUDA)\n", (int)params.deviceType);
    fprintf(stderr, "[NVENC]   device=%p (ID3D11Device*)\n", params.device);
    fprintf(stderr, "[NVENC]   apiVersion=0x%08X\n", params.apiVersion);
    fprintf(stderr, "[NVENC]   sizeof(params)=%zu\n", sizeof(params));
    fprintf(stderr, "[NVENC]   Process: %s-bit\n", sizeof(void*) == 8 ? "64" : "32");

    NVENCSTATUS status = fn->nvEncOpenEncodeSessionEx(&params, &s_encoder);
    fprintf(stderr, "[NVENC]   result: %s (%u) encoder=%p\n",
            nvencStatusStr(status), status, s_encoder);

    if (status != NV_ENC_SUCCESS) {
        s_lastError = std::string("nvEncOpenEncodeSessionEx: ") + nvencStatusStr(status) +
                      " (" + std::to_string(status) + ")";
        s_encoder = nullptr;
        return false;
    }

    return true;
}

bool configure(const EncoderConfig& cfg) {
    if (!s_encoder) { s_lastError = "Session not open"; return false; }

    auto* fn = getNvencFunctions();
    s_config = cfg;

    // Get preset config as starting point
    NV_ENC_PRESET_CONFIG presetConfig = {};
    presetConfig.version = NV_ENC_PRESET_CONFIG_VER;
    presetConfig.presetCfg.version = NV_ENC_CONFIG_VER;

    const GUID& presetGuid = getPresetGuid(cfg.preset);

    NVENCSTATUS status = fn->nvEncGetEncodePresetConfigEx(
        s_encoder,
        NV_ENC_CODEC_H264_GUID,
        presetGuid,
        NV_ENC_TUNING_INFO_HIGH_QUALITY,
        &presetConfig
    );

    if (status != NV_ENC_SUCCESS) {
        // Fallback: try without Ex (older drivers)
        status = fn->nvEncGetEncodePresetConfig(
            s_encoder,
            NV_ENC_CODEC_H264_GUID,
            presetGuid,
            &presetConfig
        );
        if (status != NV_ENC_SUCCESS) {
            s_lastError = "nvEncGetEncodePresetConfig failed: " + std::to_string(status);
            return false;
        }
    }

    // Customize the config
    NV_ENC_CONFIG encConfig = presetConfig.presetCfg;

    // Profile: High
    encConfig.profileGUID = NV_ENC_H264_PROFILE_HIGH_GUID;

    // GOP + B-frames
    encConfig.gopLength = cfg.gop;
    encConfig.frameIntervalP = cfg.bframes + 1; // IBBP = 3

    // Rate control
    encConfig.rcParams.rateControlMode = getRcMode(cfg.rc);
    encConfig.rcParams.averageBitRate = cfg.bitrate;
    encConfig.rcParams.maxBitRate = cfg.maxBitrate;
    encConfig.rcParams.vbvBufferSize = cfg.maxBitrate; // 1 second buffer
    encConfig.rcParams.vbvInitialDelay = cfg.maxBitrate; // full buffer at start

    // Spatial AQ
    encConfig.rcParams.enableAQ = 1;
    encConfig.rcParams.aqStrength = 0; // 0 = auto

    // Lookahead
    encConfig.rcParams.enableLookahead = 1;
    encConfig.rcParams.lookaheadDepth = 16;

    // Multi-pass (VBR HQ / CBR HQ use two-pass full resolution)
    if (cfg.rc == "vbr_hq" || cfg.rc == "cbr_hq") {
        encConfig.rcParams.multiPass = NV_ENC_TWO_PASS_FULL_RESOLUTION;
    }

    // H.264 specific
    encConfig.encodeCodecConfig.h264Config.idrPeriod = cfg.gop;
    encConfig.encodeCodecConfig.h264Config.repeatSPSPPS = 1; // SPS/PPS before each IDR
    encConfig.encodeCodecConfig.h264Config.entropyCodingMode = NV_ENC_H264_ENTROPY_CODING_MODE_CABAC;
    encConfig.encodeCodecConfig.h264Config.chromaFormatIDC = 1; // 4:2:0
    encConfig.encodeCodecConfig.h264Config.level = NV_ENC_LEVEL_AUTOSELECT;

    // Initialize encoder
    NV_ENC_INITIALIZE_PARAMS initParams = {};
    initParams.version = NV_ENC_INITIALIZE_PARAMS_VER;
    initParams.encodeGUID = NV_ENC_CODEC_H264_GUID;
    initParams.presetGUID = presetGuid;
    initParams.encodeWidth = cfg.width;
    initParams.encodeHeight = cfg.height;
    initParams.darWidth = cfg.width;
    initParams.darHeight = cfg.height;
    initParams.frameRateNum = cfg.fps;
    initParams.frameRateDen = 1;
    initParams.enablePTD = 1; // picture type decision by encoder
    initParams.encodeConfig = &encConfig;
    initParams.maxEncodeWidth = cfg.width;
    initParams.maxEncodeHeight = cfg.height;
    initParams.tuningInfo = NV_ENC_TUNING_INFO_HIGH_QUALITY;

    status = fn->nvEncInitializeEncoder(s_encoder, &initParams);
    if (status != NV_ENC_SUCCESS) {
        s_lastError = "nvEncInitializeEncoder failed: " + std::to_string(status);
        return false;
    }

    // Create bitstream output buffer
    NV_ENC_CREATE_BITSTREAM_BUFFER bsParams = {};
    bsParams.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;

    status = fn->nvEncCreateBitstreamBuffer(s_encoder, &bsParams);
    if (status != NV_ENC_SUCCESS) {
        s_lastError = "nvEncCreateBitstreamBuffer failed: " + std::to_string(status);
        return false;
    }
    s_bitstreamBuffer = bsParams.bitstreamBuffer;

    return true;
}

bool registerTexture(ID3D11Texture2D* texture) {
    if (!s_encoder || !texture) {
        s_lastError = "No encoder or texture";
        return false;
    }

    auto* fn = getNvencFunctions();

    NV_ENC_REGISTER_RESOURCE regParams = {};
    regParams.version = NV_ENC_REGISTER_RESOURCE_VER;
    regParams.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
    regParams.resourceToRegister = texture;
    regParams.width = s_config.width;
    regParams.height = s_config.height;
    regParams.pitch = 0; // D3D11 textures don't need pitch
    regParams.bufferFormat = NV_ENC_BUFFER_FORMAT_ARGB; // BGRA in D3D11 byte order
    regParams.bufferUsage = 0; // NV_ENC_INPUT_IMAGE

    NVENCSTATUS status = fn->nvEncRegisterResource(s_encoder, &regParams);
    if (status != NV_ENC_SUCCESS) {
        s_lastError = "nvEncRegisterResource failed: " + std::to_string(status);
        return false;
    }
    s_registeredResource = regParams.registeredResource;

    return true;
}

// Write a single frame's bitstream data from a lock result
static bool writeBitstream(NV_ENC_LOCK_BITSTREAM& lockParams, FILE* outFile) {
    if (lockParams.bitstreamSizeInBytes > 0 && lockParams.bitstreamBufferPtr) {
        size_t written = fwrite(lockParams.bitstreamBufferPtr, 1, lockParams.bitstreamSizeInBytes, outFile);
        if (written != lockParams.bitstreamSizeInBytes) {
            s_lastError = "fwrite failed";
            return false;
        }
    }
    return true;
}

bool encodeFrame(FILE* outFile) {
    if (!s_encoder || !s_registeredResource || !s_bitstreamBuffer) {
        s_lastError = "Encoder not fully initialized";
        return false;
    }

    auto* fn = getNvencFunctions();

    // Map the registered resource
    NV_ENC_MAP_INPUT_RESOURCE mapParams = {};
    mapParams.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
    mapParams.registeredResource = s_registeredResource;

    NVENCSTATUS status = fn->nvEncMapInputResource(s_encoder, &mapParams);
    if (status != NV_ENC_SUCCESS) {
        s_lastError = "nvEncMapInputResource failed: " + std::to_string(status);
        return false;
    }

    // Encode
    NV_ENC_PIC_PARAMS picParams = {};
    picParams.version = NV_ENC_PIC_PARAMS_VER;
    picParams.inputWidth = s_config.width;
    picParams.inputHeight = s_config.height;
    picParams.inputPitch = 0;
    picParams.encodePicFlags = 0;
    picParams.inputBuffer = mapParams.mappedResource;
    picParams.outputBitstream = s_bitstreamBuffer;
    picParams.bufferFmt = mapParams.mappedBufferFmt;
    picParams.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
    picParams.pictureType = NV_ENC_PIC_TYPE_UNKNOWN; // let encoder decide (PTD=1)

    status = fn->nvEncEncodePicture(s_encoder, &picParams);

    // Unmap regardless of encode result
    fn->nvEncUnmapInputResource(s_encoder, mapParams.mappedResource);

    if (status == NV_ENC_SUCCESS) {
        // Frame encoded, lock and write bitstream
        NV_ENC_LOCK_BITSTREAM lockParams = {};
        lockParams.version = NV_ENC_LOCK_BITSTREAM_VER;
        lockParams.outputBitstream = s_bitstreamBuffer;

        status = fn->nvEncLockBitstream(s_encoder, &lockParams);
        if (status != NV_ENC_SUCCESS) {
            s_lastError = "nvEncLockBitstream failed: " + std::to_string(status);
            return false;
        }

        bool ok = writeBitstream(lockParams, outFile);
        fn->nvEncUnlockBitstream(s_encoder, s_bitstreamBuffer);
        return ok;
    } else if (status == NV_ENC_ERR_NEED_MORE_INPUT) {
        // B-frames buffered, output will come later — this is normal
        return true;
    } else {
        s_lastError = "nvEncEncodePicture failed: " + std::to_string(status);
        return false;
    }
}

bool flush(FILE* outFile) {
    if (!s_encoder) return true;

    auto* fn = getNvencFunctions();

    // Send EOS
    NV_ENC_PIC_PARAMS eosParams = {};
    eosParams.version = NV_ENC_PIC_PARAMS_VER;
    eosParams.encodePicFlags = NV_ENC_PIC_FLAG_EOS;

    NVENCSTATUS status = fn->nvEncEncodePicture(s_encoder, &eosParams);

    // Drain all remaining frames
    while (status == NV_ENC_SUCCESS || status == NV_ENC_ERR_NEED_MORE_INPUT) {
        NV_ENC_LOCK_BITSTREAM lockParams = {};
        lockParams.version = NV_ENC_LOCK_BITSTREAM_VER;
        lockParams.outputBitstream = s_bitstreamBuffer;

        status = fn->nvEncLockBitstream(s_encoder, &lockParams);
        if (status != NV_ENC_SUCCESS) break;

        if (lockParams.bitstreamSizeInBytes == 0) {
            fn->nvEncUnlockBitstream(s_encoder, s_bitstreamBuffer);
            break;
        }

        writeBitstream(lockParams, outFile);
        fn->nvEncUnlockBitstream(s_encoder, s_bitstreamBuffer);

        // Try to get next frame
        NV_ENC_PIC_PARAMS emptyParams = {};
        emptyParams.version = NV_ENC_PIC_PARAMS_VER;
        emptyParams.encodePicFlags = NV_ENC_PIC_FLAG_EOS;
        status = fn->nvEncEncodePicture(s_encoder, &emptyParams);
    }

    return true;
}

void closeSession() {
    if (!s_encoder) return;

    auto* fn = getNvencFunctions();
    if (!fn) {
        s_encoder = nullptr;
        return;
    }

    // Unregister resource
    if (s_registeredResource) {
        fn->nvEncUnregisterResource(s_encoder, s_registeredResource);
        s_registeredResource = nullptr;
    }

    // Destroy bitstream buffer
    if (s_bitstreamBuffer) {
        fn->nvEncDestroyBitstreamBuffer(s_encoder, s_bitstreamBuffer);
        s_bitstreamBuffer = nullptr;
    }

    // Destroy encoder
    fn->nvEncDestroyEncoder(s_encoder);
    s_encoder = nullptr;
}

bool isSessionOpen() {
    return s_encoder != nullptr;
}

std::string getLastError() {
    return s_lastError;
}

} // namespace nativeexporter
