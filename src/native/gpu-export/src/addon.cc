/**
 * addon.cc — N-API module entry point for gpu_export native addon
 *
 * Phase 1: probeAngleD3D11()      — query ANGLE D3D11 backend capabilities
 * Phase 2: shared textures        — D3D11 ring buffer with keyed mutex
 *          EGL pbuffers            — redirect rendering to shared textures
 */

#include <napi.h>
#include "angle_interop.h"
#include "shared_textures.h"
#include "egl_pbuffer.h"

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    // Phase 1: ANGLE probe
    exports.Set("probeAngleD3D11",
        Napi::Function::New(env, ProbeAngleD3D11, "probeAngleD3D11"));

    // Phase 2: Shared textures + keyed mutex
    exports.Set("createSharedTextures",
        Napi::Function::New(env, CreateSharedTextures, "createSharedTextures"));
    exports.Set("acquireKeyedMutex",
        Napi::Function::New(env, AcquireKeyedMutex, "acquireKeyedMutex"));
    exports.Set("releaseKeyedMutex",
        Napi::Function::New(env, ReleaseKeyedMutex, "releaseKeyedMutex"));
    exports.Set("readTextureToBuffer",
        Napi::Function::New(env, ReadTextureToBuffer, "readTextureToBuffer"));
    exports.Set("destroySharedTextures",
        Napi::Function::New(env, DestroySharedTextures, "destroySharedTextures"));

    // Phase 2: EGL pbuffer surfaces
    exports.Set("createPbufferSurfaces",
        Napi::Function::New(env, CreatePbufferSurfaces, "createPbufferSurfaces"));
    exports.Set("makePbufferCurrent",
        Napi::Function::New(env, MakePbufferCurrent, "makePbufferCurrent"));
    exports.Set("restoreDefaultSurface",
        Napi::Function::New(env, RestoreDefaultSurface, "restoreDefaultSurface"));
    exports.Set("destroyPbufferSurfaces",
        Napi::Function::New(env, DestroyPbufferSurfaces, "destroyPbufferSurfaces"));
    exports.Set("renderSolidColor",
        Napi::Function::New(env, RenderSolidColor, "renderSolidColor"));

    return exports;
}

NODE_API_MODULE(gpu_export, Init)
