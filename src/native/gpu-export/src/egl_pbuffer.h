#pragma once
/**
 * egl_pbuffer.h — EGL pbuffer surface management
 *
 * Creates EGL pbuffer surfaces from D3D11 shared texture share handles
 * using EGL_ANGLE_d3d_share_handle_client_buffer extension.
 *
 * Provides makeCurrent/restore to redirect WebGL rendering to shared textures.
 */

#include <napi.h>
#include <cstdint>

#define MAX_PBUFFER_SURFACES 4

// Create pbuffer surfaces from the share handles in shared_textures module.
// Must call createSharedTextures() first.
bool createPbufferSurfaces(uint32_t count);

// Switch EGL draw surface to pbuffer[index].
// Saves current surface for later restore.
bool makePbufferCurrent(uint32_t index);

// Restore the original EGL draw surface (the window surface).
bool restoreDefaultSurface();

// Release all pbuffer surfaces.
void destroyPbufferSurfaces();

// Render a solid color to the current pbuffer surface (for POC testing).
bool renderSolidColor(float r, float g, float b, float a);

// N-API wrappers
Napi::Value CreatePbufferSurfaces(const Napi::CallbackInfo& info);
Napi::Value MakePbufferCurrent(const Napi::CallbackInfo& info);
Napi::Value RestoreDefaultSurface(const Napi::CallbackInfo& info);
Napi::Value DestroyPbufferSurfaces(const Napi::CallbackInfo& info);
Napi::Value RenderSolidColor(const Napi::CallbackInfo& info);
