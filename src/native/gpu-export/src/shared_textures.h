#pragma once
/**
 * shared_textures.h — D3D11 shared texture ring buffer with keyed mutex
 *
 * Creates N textures with DXGI_FORMAT_B8G8R8A8_UNORM + MISC_SHARED_KEYEDMUTEX.
 * Each texture has a matching staging texture for CPU readback.
 * Keyed mutex protocol:
 *   key=0 → renderer owns (acquire before GL render, release after)
 *   key=1 → encoder owns  (acquire before D3D11 readback, release after)
 */

#include <napi.h>
#include <cstdint>

// Max textures in the ring buffer
#define MAX_SHARED_TEXTURES 4

// Create count shared textures at given resolution.
// Returns false on error (check stderr for details).
bool createSharedTextures(uint32_t width, uint32_t height, uint32_t count);

// Get the DXGI share handle for texture at index (for EGL pbuffer import).
void* getShareHandle(uint32_t index);

// Keyed mutex: acquire for rendering (key=acquireKey), blocks up to timeoutMs.
bool acquireKeyedMutex(uint32_t index, uint64_t key, uint32_t timeoutMs);

// Keyed mutex: release with key.
bool releaseKeyedMutex(uint32_t index, uint64_t key);

// Read texture pixels into outBuf via D3D11 CopyResource + Map.
// outBuf must be width*height*4 bytes (BGRA).
bool readTextureToBuffer(uint32_t index, void* outBuf, uint32_t bufSize);

// Get texture count and dimensions.
uint32_t getSharedTextureCount();
uint32_t getSharedTextureWidth();
uint32_t getSharedTextureHeight();

// Release all textures and staging resources.
void destroySharedTextures();

// N-API wrappers
Napi::Value CreateSharedTextures(const Napi::CallbackInfo& info);
Napi::Value AcquireKeyedMutex(const Napi::CallbackInfo& info);
Napi::Value ReleaseKeyedMutex(const Napi::CallbackInfo& info);
Napi::Value ReadTextureToBuffer(const Napi::CallbackInfo& info);
Napi::Value DestroySharedTextures(const Napi::CallbackInfo& info);
