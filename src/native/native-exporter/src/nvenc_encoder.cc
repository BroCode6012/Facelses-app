#include "nvenc_encoder.h"
#include "nvenc_loader.h"
#include "d3d11_device.h"
#include "../include/nvEncodeAPI.h"
#include <windows.h>
#include <cstring>
#include <cstdio>

namespace nativeexporter {

static void* s_encoder = nullptr;
static std::string s_lastError;
static EncoderConfig s_config;
static uint64_t s_frameIndex = 0;
static bool s_initialized = false;
static bool s_verbose = true;  // verbose logging (init only by default after first frame)

// Multi-slot input textures + registered resources
static ID3D11Texture2D*       s_inputTextures[MAX_INFLIGHT_SLOTS] = {};
static NV_ENC_REGISTERED_PTR  s_registeredResources[MAX_INFLIGHT_SLOTS] = {};
static bool                   s_slotIsNV12[MAX_INFLIGHT_SLOTS] = {};
static int                    s_numSlots = 0;

// Ring of output bitstream buffers (needed for B-frame reordering)
static const int MAX_OUTPUT_BUFFERS = 16;
static NV_ENC_OUTPUT_PTR s_bitstreamBuffers[MAX_OUTPUT_BUFFERS] = {};
static int s_numBuffers = 0;
static int s_sendIdx = 0;
static int s_readIdx = 0;

static const char* nvencStatusStr(NVENCSTATUS s) {
    switch (s) {
        case NV_ENC_SUCCESS: return "SUCCESS";
        case NV_ENC_ERR_NO_ENCODE_DEVICE: return "NO_ENCODE_DEVICE";
        case NV_ENC_ERR_UNSUPPORTED_DEVICE: return "UNSUPPORTED_DEVICE";
        case NV_ENC_ERR_INVALID_ENCODERDEVICE: return "INVALID_ENCODERDEVICE";
        case NV_ENC_ERR_INVALID_DEVICE: return "INVALID_DEVICE";
        case NV_ENC_ERR_DEVICE_NOT_EXIST: return "DEVICE_NOT_EXIST";
        case NV_ENC_ERR_INVALID_PTR: return "INVALID_PTR";
        case NV_ENC_ERR_INVALID_EVENT: return "INVALID_EVENT";
        case NV_ENC_ERR_INVALID_PARAM: return "INVALID_PARAM";
        case NV_ENC_ERR_INVALID_CALL: return "INVALID_CALL";
        case NV_ENC_ERR_OUT_OF_MEMORY: return "OUT_OF_MEMORY";
        case NV_ENC_ERR_ENCODER_NOT_INITIALIZED: return "ENCODER_NOT_INITIALIZED";
        case NV_ENC_ERR_UNSUPPORTED_PARAM: return "UNSUPPORTED_PARAM";
        case NV_ENC_ERR_LOCK_BUSY: return "LOCK_BUSY";
        case NV_ENC_ERR_NOT_ENOUGH_BUFFER: return "NOT_ENOUGH_BUFFER";
        case NV_ENC_ERR_INVALID_VERSION: return "INVALID_VERSION";
        case NV_ENC_ERR_MAP_FAILED: return "MAP_FAILED";
        case NV_ENC_ERR_NEED_MORE_INPUT: return "NEED_MORE_INPUT";
        case NV_ENC_ERR_ENCODER_BUSY: return "ENCODER_BUSY";
        case NV_ENC_ERR_EVENT_NOT_REGISTERD: return "EVENT_NOT_REGISTERD";
        case NV_ENC_ERR_GENERIC: return "GENERIC";
        case NV_ENC_ERR_INCOMPATIBLE_CLIENT_KEY: return "INCOMPATIBLE_CLIENT_KEY";
        case NV_ENC_ERR_UNIMPLEMENTED: return "UNIMPLEMENTED";
        case NV_ENC_ERR_RESOURCE_REGISTER_FAILED: return "RESOURCE_REGISTER_FAILED";
        case NV_ENC_ERR_RESOURCE_NOT_REGISTERED: return "RESOURCE_NOT_REGISTERED";
        case NV_ENC_ERR_RESOURCE_NOT_MAPPED: return "RESOURCE_NOT_MAPPED";
        case NV_ENC_ERR_NEED_MORE_OUTPUT: return "NEED_MORE_OUTPUT";
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
    if (rc == "cbr_hq") return NV_ENC_PARAMS_RC_CBR;
    return NV_ENC_PARAMS_RC_VBR;
}

void setVerboseLogging(bool v) { s_verbose = v; }

bool openSession(ID3D11Device* device) {
    if (s_encoder) return true;
    if (!device) { s_lastError = "No D3D11 device"; return false; }
    s_initialized = false;
    for (int i = 0; i < MAX_OUTPUT_BUFFERS; i++) s_bitstreamBuffers[i] = nullptr;
    s_numBuffers = 0;
    s_sendIdx = 0;
    s_readIdx = 0;
    for (int i = 0; i < MAX_INFLIGHT_SLOTS; i++) {
        s_inputTextures[i] = nullptr;
        s_registeredResources[i] = nullptr;
        s_slotIsNV12[i] = false;
    }
    s_numSlots = 0;
    s_frameIndex = 0;

    auto* fn = getNvencFunctions();
    if (!fn) { s_lastError = "NVENC function list is null"; return false; }

    if (!fn->nvEncOpenEncodeSessionEx) {
        s_lastError = "nvEncOpenEncodeSessionEx function pointer is null";
        return false;
    }

    uint32_t maxSupportedVersion = getNvencMaxSupportedApiVersion();
    uint32_t requestedVersion = NVENCAPI_VERSION;
    uint32_t negotiatedVersion = requestedVersion;

    if (maxSupportedVersion != 0 && requestedVersion > maxSupportedVersion) {
        negotiatedVersion = maxSupportedVersion;
    }

    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS params = {0};
    params.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
    params.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
    params.device = (void*)device;
    params.apiVersion = negotiatedVersion;

    fprintf(stderr, "[NVENC] Opening session (apiVersion=0x%08X)...\n", negotiatedVersion);

    NVENCSTATUS st = fn->nvEncOpenEncodeSessionEx(&params, &s_encoder);
    fprintf(stderr, "[NVENC] Session: %s (%u) encoder=%p\n", nvencStatusStr(st), st, s_encoder);

    if (st != NV_ENC_SUCCESS) {
        s_lastError = std::string("nvEncOpenEncodeSessionEx: ") + nvencStatusStr(st);
        s_encoder = nullptr;
        return false;
    }

    return true;
}

bool configure(const EncoderConfig& cfg) {
    if (!s_encoder) { s_lastError = "Session not open"; return false; }

    auto* fn = getNvencFunctions();
    s_config = cfg;
    s_initialized = false;

    // Apply speed preset overrides
    bool isFast = (cfg.speedPreset == "fast");
    EncoderConfig effectiveCfg = cfg;
    if (isFast) {
        effectiveCfg.preset = 1;  // P1 (fastest)
        effectiveCfg.bframes = 0;
        effectiveCfg.rc = "vbr";
        fprintf(stderr, "[NVENC] FAST preset: P1, 0 B-frames, single-pass VBR, no AQ\n");
    } else {
        fprintf(stderr, "[NVENC] QUALITY preset: P%u, %u B-frames, %s\n",
                effectiveCfg.preset, effectiveCfg.bframes, effectiveCfg.rc.c_str());
    }

    const GUID& presetGuid = getPresetGuid(effectiveCfg.preset);

    NV_ENC_PRESET_CONFIG presetConfig = {};
    presetConfig.version = NV_ENC_PRESET_CONFIG_VER;
    presetConfig.presetCfg.version = NV_ENC_CONFIG_VER;

    NV_ENC_TUNING_INFO tuningInfo = isFast ? NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY
                                           : NV_ENC_TUNING_INFO_HIGH_QUALITY;

    NVENCSTATUS status = fn->nvEncGetEncodePresetConfigEx(
        s_encoder, NV_ENC_CODEC_H264_GUID, presetGuid,
        tuningInfo, &presetConfig);

    if (status != NV_ENC_SUCCESS) {
        status = fn->nvEncGetEncodePresetConfig(
            s_encoder, NV_ENC_CODEC_H264_GUID, presetGuid, &presetConfig);
        if (status != NV_ENC_SUCCESS) {
            s_lastError = "nvEncGetEncodePresetConfig failed: " + std::to_string(status);
            return false;
        }
    }

    NV_ENC_CONFIG encConfig = presetConfig.presetCfg;
    encConfig.profileGUID = NV_ENC_H264_PROFILE_HIGH_GUID;
    encConfig.gopLength = effectiveCfg.gop;
    encConfig.frameIntervalP = effectiveCfg.bframes + 1;
    encConfig.rcParams.rateControlMode = getRcMode(effectiveCfg.rc);
    encConfig.rcParams.averageBitRate = effectiveCfg.bitrate;
    encConfig.rcParams.maxBitRate = effectiveCfg.maxBitrate;
    encConfig.rcParams.vbvBufferSize = effectiveCfg.maxBitrate;
    encConfig.rcParams.vbvInitialDelay = effectiveCfg.maxBitrate;

    if (isFast) {
        // FAST: single pass, no AQ, CAVLC for speed
        encConfig.rcParams.multiPass = NV_ENC_MULTI_PASS_DISABLED;
        encConfig.rcParams.enableAQ = 0;
        encConfig.rcParams.enableLookahead = 0;
        encConfig.rcParams.lookaheadDepth = 0;
        encConfig.encodeCodecConfig.h264Config.entropyCodingMode = NV_ENC_H264_ENTROPY_CODING_MODE_CAVLC;
    } else {
        // QUALITY: two-pass, AQ, CABAC
        encConfig.rcParams.enableAQ = 1;
        encConfig.rcParams.aqStrength = 0;
        encConfig.rcParams.enableLookahead = 0;
        encConfig.rcParams.lookaheadDepth = 0;
        if (effectiveCfg.rc == "vbr_hq" || effectiveCfg.rc == "cbr_hq") {
            encConfig.rcParams.multiPass = NV_ENC_TWO_PASS_FULL_RESOLUTION;
        }
        encConfig.encodeCodecConfig.h264Config.entropyCodingMode = NV_ENC_H264_ENTROPY_CODING_MODE_CABAC;
    }

    encConfig.encodeCodecConfig.h264Config.idrPeriod = effectiveCfg.gop;
    encConfig.encodeCodecConfig.h264Config.repeatSPSPPS = 1;
    encConfig.encodeCodecConfig.h264Config.chromaFormatIDC = 1;
    encConfig.encodeCodecConfig.h264Config.level = NV_ENC_LEVEL_AUTOSELECT;

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
    initParams.enablePTD = 1;
    initParams.encodeConfig = &encConfig;
    initParams.maxEncodeWidth = effectiveCfg.width;
    initParams.maxEncodeHeight = effectiveCfg.height;
    initParams.tuningInfo = tuningInfo;
    initParams.enableEncodeAsync = 0;  // sync mode for D3D11

    status = fn->nvEncInitializeEncoder(s_encoder, &initParams);
    fprintf(stderr, "[NVENC] nvEncInitializeEncoder: %s (%u)\n", nvencStatusStr(status), status);
    if (status != NV_ENC_SUCCESS) {
        s_lastError = "nvEncInitializeEncoder failed: " + std::to_string(status);
        return false;
    }

    // Deeper async depth: more output buffers for pipeline
    s_numBuffers = effectiveCfg.bframes + 4;
    if (isFast && s_numBuffers < 8) s_numBuffers = 8; // deeper pipeline for FAST
    if (s_numBuffers > MAX_OUTPUT_BUFFERS) s_numBuffers = MAX_OUTPUT_BUFFERS;

    fprintf(stderr, "[NVENC] Creating %d output bitstream buffers (bframes=%u, preset=%s)\n",
            s_numBuffers, effectiveCfg.bframes, isFast ? "fast" : "quality");

    for (int i = 0; i < s_numBuffers; i++) {
        NV_ENC_CREATE_BITSTREAM_BUFFER bsParams = {};
        bsParams.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;

        status = fn->nvEncCreateBitstreamBuffer(s_encoder, &bsParams);
        if (status != NV_ENC_SUCCESS) {
            s_lastError = "nvEncCreateBitstreamBuffer[" + std::to_string(i) + "] failed";
            for (int j = 0; j < i; j++) {
                fn->nvEncDestroyBitstreamBuffer(s_encoder, s_bitstreamBuffers[j]);
                s_bitstreamBuffers[j] = nullptr;
            }
            s_numBuffers = 0;
            return false;
        }
        s_bitstreamBuffers[i] = bsParams.bitstreamBuffer;
    }

    s_frameIndex = 0;
    s_sendIdx = 0;
    s_readIdx = 0;
    s_initialized = true;

    return true;
}

// ============================================================================
// Slot registration
// ============================================================================

bool registerTextureSlot(int slot, ID3D11Texture2D* texture, bool nv12) {
    if (!s_encoder || !s_initialized || !texture || slot < 0 || slot >= MAX_INFLIGHT_SLOTS) {
        s_lastError = "Invalid slot or encoder not ready";
        return false;
    }

    auto* fn = getNvencFunctions();

    // Unregister old resource if any
    if (s_registeredResources[slot]) {
        fn->nvEncUnregisterResource(s_encoder, s_registeredResources[slot]);
        s_registeredResources[slot] = nullptr;
    }

    // Register the texture
    NV_ENC_REGISTER_RESOURCE regParams = {};
    regParams.version = NV_ENC_REGISTER_RESOURCE_VER;
    regParams.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
    regParams.resourceToRegister = texture;
    regParams.width = s_config.width;
    regParams.height = s_config.height;
    regParams.pitch = 0;
    regParams.bufferFormat = nv12 ? NV_ENC_BUFFER_FORMAT_NV12 : NV_ENC_BUFFER_FORMAT_ARGB;
    regParams.bufferUsage = NV_ENC_INPUT_IMAGE;

    NVENCSTATUS st = fn->nvEncRegisterResource(s_encoder, &regParams);
    if (st != NV_ENC_SUCCESS) {
        s_lastError = "nvEncRegisterResource slot[" + std::to_string(slot) + "] failed: " + nvencStatusStr(st);
        fprintf(stderr, "[NVENC] RegisterResource slot[%d]: %s (%u)\n", slot, nvencStatusStr(st), st);
        return false;
    }

    s_inputTextures[slot] = texture;
    s_registeredResources[slot] = regParams.registeredResource;
    s_slotIsNV12[slot] = nv12;

    if (slot >= s_numSlots) s_numSlots = slot + 1;

    fprintf(stderr, "[NVENC] Registered slot[%d]: tex=%p fmt=%s resource=%p\n",
            slot, (void*)texture, nv12 ? "NV12" : "ARGB", regParams.registeredResource);
    return true;
}

// Legacy single-slot wrappers
bool registerTexture(ID3D11Texture2D* texture) {
    return registerTextureSlot(0, texture, false);
}

bool registerTextureNV12(ID3D11Texture2D* texture) {
    return registerTextureSlot(0, texture, true);
}

int getRegisteredSlotCount() { return s_numSlots; }

// ============================================================================
// Bitstream helpers
// ============================================================================

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

static bool drainPending(FILE* outFile, int endIdx) {
    auto* fn = getNvencFunctions();
    while (s_readIdx < endIdx) {
        int bufIdx = s_readIdx % s_numBuffers;

        NV_ENC_LOCK_BITSTREAM lockParams = {};
        lockParams.version = NV_ENC_LOCK_BITSTREAM_VER;
        lockParams.outputBitstream = s_bitstreamBuffers[bufIdx];

        NVENCSTATUS lockStatus = fn->nvEncLockBitstream(s_encoder, &lockParams);
        if (lockStatus != NV_ENC_SUCCESS) {
            s_lastError = "nvEncLockBitstream(drain) failed: " + std::to_string(lockStatus);
            return false;
        }

        bool ok = writeBitstream(lockParams, outFile);
        fn->nvEncUnlockBitstream(s_encoder, s_bitstreamBuffers[bufIdx]);
        if (!ok) return false;

        s_readIdx++;
    }
    return true;
}

// ============================================================================
// Encode from specific slot
// ============================================================================

bool encodeFrameSlot(int slot, FILE* outFile) {
    if (!s_encoder || !s_initialized || s_numBuffers == 0) {
        s_lastError = "Encoder not initialized";
        return false;
    }
    if (slot < 0 || slot >= s_numSlots || !s_registeredResources[slot]) {
        s_lastError = "Invalid slot " + std::to_string(slot);
        return false;
    }

    auto* fn = getNvencFunctions();

    // Map the slot's registered resource
    NV_ENC_MAP_INPUT_RESOURCE mapParams = {};
    mapParams.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
    mapParams.registeredResource = s_registeredResources[slot];

    NVENCSTATUS status = fn->nvEncMapInputResource(s_encoder, &mapParams);
    if (status != NV_ENC_SUCCESS) {
        s_lastError = "nvEncMapInputResource slot[" + std::to_string(slot) + "] failed";
        return false;
    }

    int bufIdx = s_sendIdx % s_numBuffers;

    NV_ENC_PIC_PARAMS picParams = {};
    picParams.version = NV_ENC_PIC_PARAMS_VER;
    picParams.inputWidth = s_config.width;
    picParams.inputHeight = s_config.height;
    picParams.inputPitch = 0;
    picParams.encodePicFlags = 0;
    if (s_frameIndex == 0) {
        picParams.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
    }
    picParams.inputBuffer = mapParams.mappedResource;
    picParams.outputBitstream = s_bitstreamBuffers[bufIdx];
    picParams.bufferFmt = mapParams.mappedBufferFmt;
    picParams.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
    picParams.pictureType = NV_ENC_PIC_TYPE_UNKNOWN;

    status = fn->nvEncEncodePicture(s_encoder, &picParams);
    fn->nvEncUnmapInputResource(s_encoder, mapParams.mappedResource);

    s_sendIdx++;
    s_frameIndex++;

    if (status == NV_ENC_SUCCESS) {
        return drainPending(outFile, s_sendIdx);
    } else if (status == NV_ENC_ERR_NEED_MORE_INPUT) {
        return true;
    } else {
        s_lastError = std::string("nvEncEncodePicture failed: ") + nvencStatusStr(status);
        return false;
    }
}

// Legacy: encode from slot 0
bool encodeFrame(FILE* outFile) {
    // Legacy path: if no slots registered, do lazy registration (backward compat)
    if (s_numSlots == 0 && s_inputTextures[0] == nullptr) {
        s_lastError = "No input texture registered";
        return false;
    }
    return encodeFrameSlot(0, outFile);
}

// ============================================================================
// Flush + Close
// ============================================================================

bool flush(FILE* outFile) {
    fprintf(stderr, "[NVENC] flush() sendIdx=%d readIdx=%d frameIndex=%u\n",
            s_sendIdx, s_readIdx, (unsigned)s_frameIndex);

    if (!s_encoder) return true;

    auto* fn = getNvencFunctions();
    if (!fn || s_numBuffers == 0) {
        s_lastError = "No bitstream buffers for flush";
        return false;
    }

    NV_ENC_PIC_PARAMS eosParams = {};
    eosParams.version = NV_ENC_PIC_PARAMS_VER;
    eosParams.encodePicFlags = NV_ENC_PIC_FLAG_EOS;

    NVENCSTATUS encodeStatus = fn->nvEncEncodePicture(s_encoder, &eosParams);
    fprintf(stderr, "[NVENC] EOS: %s, draining %d pending\n",
            nvencStatusStr(encodeStatus), s_sendIdx - s_readIdx);

    if (encodeStatus != NV_ENC_SUCCESS && encodeStatus != NV_ENC_ERR_NEED_MORE_INPUT) {
        s_lastError = "nvEncEncodePicture(EOS) failed";
        return false;
    }

    return drainPending(outFile, s_sendIdx);
}

void closeSession() {
    if (!s_encoder) {
        for (int i = 0; i < MAX_INFLIGHT_SLOTS; i++) {
            s_inputTextures[i] = nullptr;
            s_registeredResources[i] = nullptr;
            s_slotIsNV12[i] = false;
        }
        s_numSlots = 0;
        for (int i = 0; i < MAX_OUTPUT_BUFFERS; i++) s_bitstreamBuffers[i] = nullptr;
        s_numBuffers = 0;
        s_sendIdx = 0;
        s_readIdx = 0;
        s_initialized = false;
        s_frameIndex = 0;
        return;
    }

    auto* fn = getNvencFunctions();
    if (!fn) {
        s_encoder = nullptr;
        return;
    }

    // Unregister all slot resources
    for (int i = 0; i < MAX_INFLIGHT_SLOTS; i++) {
        if (s_registeredResources[i]) {
            fn->nvEncUnregisterResource(s_encoder, s_registeredResources[i]);
            s_registeredResources[i] = nullptr;
        }
        s_inputTextures[i] = nullptr;
        s_slotIsNV12[i] = false;
    }
    s_numSlots = 0;

    // Destroy bitstream buffers
    for (int i = 0; i < s_numBuffers; i++) {
        if (s_bitstreamBuffers[i]) {
            fn->nvEncDestroyBitstreamBuffer(s_encoder, s_bitstreamBuffers[i]);
            s_bitstreamBuffers[i] = nullptr;
        }
    }
    s_numBuffers = 0;
    s_sendIdx = 0;
    s_readIdx = 0;

    fn->nvEncDestroyEncoder(s_encoder);
    s_encoder = nullptr;
    s_initialized = false;
    s_frameIndex = 0;
}

bool isSessionOpen() { return s_encoder != nullptr; }
std::string getLastError() { return s_lastError; }

} // namespace nativeexporter
