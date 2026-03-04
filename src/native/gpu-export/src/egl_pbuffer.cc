/**
 * egl_pbuffer.cc — EGL pbuffer surface implementation
 *
 * Uses EGL_ANGLE_d3d_share_handle_client_buffer to create EGL pbuffer
 * surfaces backed by D3D11 shared textures (from shared_textures module).
 */

#include "egl_pbuffer.h"
#include "angle_interop.h"
#include "shared_textures.h"

#include <windows.h>
#include <cstdint>
#include <cstdio>

// ============================================================================
// EGL types (avoid header dependency)
// ============================================================================

typedef void*          EGLDisplay;
typedef void*          EGLSurface;
typedef void*          EGLContext;
typedef void*          EGLConfig;
typedef void*          EGLClientBuffer;
typedef unsigned int   EGLBoolean;
typedef int32_t        EGLint;

#define EGL_NO_SURFACE           ((EGLSurface)0)
#define EGL_NO_CONTEXT           ((EGLContext)0)
#define EGL_TRUE                 1
#define EGL_FALSE                0
#define EGL_SUCCESS              0x3000
#define EGL_NONE                 0x3038

// EGL config attributes (EGL spec order: buffer, alpha, blue, green, red, depth, stencil)
#define EGL_BUFFER_SIZE          0x3020
#define EGL_ALPHA_SIZE           0x3021
#define EGL_BLUE_SIZE            0x3022
#define EGL_GREEN_SIZE           0x3023
#define EGL_RED_SIZE             0x3024
#define EGL_DEPTH_SIZE           0x3025
#define EGL_STENCIL_SIZE         0x3026
#define EGL_SURFACE_TYPE         0x3033
#define EGL_PBUFFER_BIT          0x0001
#define EGL_RENDERABLE_TYPE      0x3040
#define EGL_OPENGL_ES2_BIT       0x0004
#define EGL_WIDTH                0x3057
#define EGL_HEIGHT               0x3056
#define EGL_TEXTURE_FORMAT       0x3080
#define EGL_TEXTURE_TARGET       0x3081
#define EGL_TEXTURE_RGBA         0x305E
#define EGL_TEXTURE_2D           0x305F

// EGL_ANGLE_d3d_share_handle_client_buffer
#define EGL_D3D_TEXTURE_2D_SHARE_HANDLE_ANGLE 0x3200

// EGL_ANGLE_keyed_mutex
#define EGL_DXGI_KEYED_MUTEX_ANGLE 0x33A2

// EGL_EXT_platform_base / EGL_ANGLE_platform_angle
#define EGL_PLATFORM_ANGLE_ANGLE             0x3202
#define EGL_PLATFORM_ANGLE_TYPE_ANGLE        0x3203
#define EGL_PLATFORM_ANGLE_TYPE_D3D11_ANGLE  0x3208

#define EGL_DRAW  0x3059
#define EGL_READ  0x305A

#ifndef EGLAPIENTRY
#define EGLAPIENTRY __stdcall
#endif

// ============================================================================
// EGL function pointer typedefs
// ============================================================================

typedef EGLBoolean (EGLAPIENTRY *pfn_eglChooseConfig)(EGLDisplay dpy, const EGLint* attribs, EGLConfig* configs, EGLint configSize, EGLint* numConfig);
typedef EGLBoolean (EGLAPIENTRY *pfn_eglGetConfigs)(EGLDisplay dpy, EGLConfig* configs, EGLint configSize, EGLint* numConfig);
typedef EGLBoolean (EGLAPIENTRY *pfn_eglGetConfigAttrib)(EGLDisplay dpy, EGLConfig config, EGLint attribute, EGLint* value);
typedef EGLSurface (EGLAPIENTRY *pfn_eglCreatePbufferFromClientBuffer)(EGLDisplay dpy, EGLint buftype, EGLClientBuffer buffer, EGLConfig config, const EGLint* attribs);
typedef EGLBoolean (EGLAPIENTRY *pfn_eglMakeCurrent)(EGLDisplay dpy, EGLSurface draw, EGLSurface read, EGLContext ctx);
typedef EGLSurface (EGLAPIENTRY *pfn_eglGetCurrentSurface)(EGLint readdraw);
typedef EGLContext (EGLAPIENTRY *pfn_eglGetCurrentContext)(void);
typedef EGLDisplay (EGLAPIENTRY *pfn_eglGetCurrentDisplay)(void);
typedef EGLBoolean (EGLAPIENTRY *pfn_eglDestroySurface)(EGLDisplay dpy, EGLSurface surface);
typedef EGLint     (EGLAPIENTRY *pfn_eglGetError)(void);
typedef EGLBoolean (EGLAPIENTRY *pfn_eglInitialize)(EGLDisplay dpy, EGLint* major, EGLint* minor);
typedef EGLDisplay (EGLAPIENTRY *pfn_eglGetDisplay)(unsigned int display_id);
typedef EGLDisplay (EGLAPIENTRY *pfn_eglGetPlatformDisplayEXT)(unsigned int platform, void* native_display, const EGLint* attrib_list);
typedef EGLContext (EGLAPIENTRY *pfn_eglCreateContext)(EGLDisplay dpy, EGLConfig config, EGLContext share_context, const EGLint* attrib_list);
typedef EGLBoolean (EGLAPIENTRY *pfn_eglDestroyContext)(EGLDisplay dpy, EGLContext ctx);

// ============================================================================
// Module state
// ============================================================================

static bool s_resolved = false;

static pfn_eglChooseConfig                   s_eglChooseConfig = nullptr;
static pfn_eglGetConfigs                     s_eglGetConfigs = nullptr;
static pfn_eglGetConfigAttrib                s_eglGetConfigAttrib = nullptr;
static pfn_eglCreatePbufferFromClientBuffer  s_eglCreatePbufferFromClientBuffer = nullptr;
static pfn_eglMakeCurrent                    s_eglMakeCurrent = nullptr;
static pfn_eglGetCurrentSurface              s_eglGetCurrentSurface = nullptr;
static pfn_eglGetCurrentContext              s_eglGetCurrentContext = nullptr;
static pfn_eglGetCurrentDisplay              s_eglGetCurrentDisplay = nullptr;
static pfn_eglDestroySurface                 s_eglDestroySurface = nullptr;
static pfn_eglGetError                       s_eglGetError = nullptr;
static pfn_eglInitialize                     s_eglInitialize = nullptr;
static pfn_eglGetDisplay                     s_eglGetDisplay_fn = nullptr;
static pfn_eglGetPlatformDisplayEXT          s_eglGetPlatformDisplayEXT = nullptr;
static pfn_eglCreateContext                  s_eglCreateContext = nullptr;
static pfn_eglDestroyContext                 s_eglDestroyContext = nullptr;

static EGLDisplay  s_display = nullptr;
static EGLConfig   s_config = nullptr;
static EGLSurface  s_pbuffers[MAX_PBUFFER_SURFACES] = {};
static uint32_t    s_pbufferCount = 0;

// Our own EGL context for pbuffer rendering
static EGLContext  s_ownContext = nullptr;

// Saved state for restore
static EGLSurface  s_savedDraw = nullptr;
static EGLSurface  s_savedRead = nullptr;
static EGLContext   s_savedContext = nullptr;
static bool         s_surfaceSaved = false;

// ============================================================================
// Helper: resolve EGL functions — core via GetProcAddress, ext via eglGetProcAddress
// ============================================================================

static bool resolveEglFunctions() {
    if (s_resolved) return (s_eglMakeCurrent != nullptr);
    s_resolved = true;

    if (!ensureEglLoaded()) return false;

    HMODULE eglLib = (HMODULE)getEglLibraryHandle();
    if (!eglLib) {
        fprintf(stderr, "[egl_pbuffer] EGL library handle not available\n");
        return false;
    }

    // Core EGL functions — loaded from DLL via GetProcAddress
    s_eglChooseConfig = (pfn_eglChooseConfig)GetProcAddress(eglLib, "eglChooseConfig");
    s_eglGetConfigs = (pfn_eglGetConfigs)GetProcAddress(eglLib, "eglGetConfigs");
    s_eglGetConfigAttrib = (pfn_eglGetConfigAttrib)GetProcAddress(eglLib, "eglGetConfigAttrib");
    s_eglMakeCurrent = (pfn_eglMakeCurrent)GetProcAddress(eglLib, "eglMakeCurrent");
    s_eglGetCurrentSurface = (pfn_eglGetCurrentSurface)GetProcAddress(eglLib, "eglGetCurrentSurface");
    s_eglGetCurrentContext = (pfn_eglGetCurrentContext)GetProcAddress(eglLib, "eglGetCurrentContext");
    s_eglGetCurrentDisplay = (pfn_eglGetCurrentDisplay)GetProcAddress(eglLib, "eglGetCurrentDisplay");
    s_eglDestroySurface = (pfn_eglDestroySurface)GetProcAddress(eglLib, "eglDestroySurface");
    s_eglGetError = (pfn_eglGetError)GetProcAddress(eglLib, "eglGetError");
    s_eglInitialize = (pfn_eglInitialize)GetProcAddress(eglLib, "eglInitialize");
    s_eglGetDisplay_fn = (pfn_eglGetDisplay)GetProcAddress(eglLib, "eglGetDisplay");
    s_eglCreateContext = (pfn_eglCreateContext)GetProcAddress(eglLib, "eglCreateContext");
    s_eglDestroyContext = (pfn_eglDestroyContext)GetProcAddress(eglLib, "eglDestroyContext");

    // Extension function — loaded via eglGetProcAddress
    typedef void* (EGLAPIENTRY *pfn_eglGetProcAddress)(const char*);
    pfn_eglGetProcAddress getProcAddr = (pfn_eglGetProcAddress)getEglGetProcAddress();
    if (getProcAddr) {
        s_eglCreatePbufferFromClientBuffer = (pfn_eglCreatePbufferFromClientBuffer)
            getProcAddr("eglCreatePbufferFromClientBuffer");
    }
    // Fallback: try from DLL too
    if (!s_eglCreatePbufferFromClientBuffer) {
        s_eglCreatePbufferFromClientBuffer = (pfn_eglCreatePbufferFromClientBuffer)
            GetProcAddress(eglLib, "eglCreatePbufferFromClientBuffer");
    }
    // Get platform display extension
    if (getProcAddr) {
        s_eglGetPlatformDisplayEXT = (pfn_eglGetPlatformDisplayEXT)
            getProcAddr("eglGetPlatformDisplayEXT");
    }
    if (!s_eglGetPlatformDisplayEXT) {
        s_eglGetPlatformDisplayEXT = (pfn_eglGetPlatformDisplayEXT)
            GetProcAddress(eglLib, "eglGetPlatformDisplayEXT");
    }

    if (!s_eglChooseConfig || !s_eglCreatePbufferFromClientBuffer ||
        !s_eglMakeCurrent || !s_eglGetCurrentSurface || !s_eglGetCurrentContext ||
        !s_eglDestroySurface || !s_eglGetError) {
        fprintf(stderr, "[egl_pbuffer] Failed to resolve required EGL functions\n");
        fprintf(stderr, "  eglChooseConfig=%p eglCreatePbufferFromClientBuffer=%p\n",
                s_eglChooseConfig, s_eglCreatePbufferFromClientBuffer);
        fprintf(stderr, "  eglMakeCurrent=%p eglGetCurrentSurface=%p eglGetCurrentContext=%p\n",
                s_eglMakeCurrent, s_eglGetCurrentSurface, s_eglGetCurrentContext);
        return false;
    }

    fprintf(stderr, "[egl_pbuffer] All EGL functions resolved\n");
    fprintf(stderr, "  eglChooseConfig=%p eglGetConfigAttrib=%p eglGetConfigs=%p\n",
            (void*)s_eglChooseConfig, (void*)s_eglGetConfigAttrib, (void*)s_eglGetConfigs);
    fprintf(stderr, "  eglCreatePbufferFromClientBuffer=%p eglGetPlatformDisplayEXT=%p\n",
            (void*)s_eglCreatePbufferFromClientBuffer, (void*)s_eglGetPlatformDisplayEXT);
    return true;
}

// ============================================================================
// Helper: choose an EGL config suitable for BGRA pbuffer
// ============================================================================

static bool chooseConfig() {
    if (s_config) return true;

    // Strategy 1: Ask for minimal 8888 RGBA pbuffer config
    const EGLint configAttribs[] = {
        EGL_RED_SIZE, 8,
        EGL_GREEN_SIZE, 8,
        EGL_BLUE_SIZE, 8,
        EGL_ALPHA_SIZE, 8,
        EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
        EGL_NONE
    };

    EGLint numConfigs = 0;
    if (s_eglChooseConfig(s_display, configAttribs, &s_config, 1, &numConfigs) && numConfigs > 0) {
        fprintf(stderr, "[egl_pbuffer] Strategy 1 (RGBA8 pbuffer): chose config (%d matched)\n", numConfigs);
        return true;
    }

    fprintf(stderr, "[egl_pbuffer] Strategy 1 failed (%d configs, error=0x%04X)\n",
            numConfigs, s_eglGetError());

    // Strategy 2: Just ask for any pbuffer config
    const EGLint configAttribs2[] = {
        EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
        EGL_NONE
    };

    numConfigs = 0;
    if (s_eglChooseConfig(s_display, configAttribs2, &s_config, 1, &numConfigs) && numConfigs > 0) {
        fprintf(stderr, "[egl_pbuffer] Strategy 2 (any pbuffer): chose config (%d matched)\n", numConfigs);
        return true;
    }

    fprintf(stderr, "[egl_pbuffer] Strategy 2 failed (%d configs, error=0x%04X)\n",
            numConfigs, s_eglGetError());

    // Strategy 3: Get ALL configs and dump them for debugging, pick best RGBA8 pbuffer
    EGLint totalConfigs = 0;
    if (s_eglGetConfigs && s_eglGetConfigAttrib) {
        s_eglGetConfigs(s_display, nullptr, 0, &totalConfigs);
        fprintf(stderr, "[egl_pbuffer] Strategy 3: %d total configs available\n", totalConfigs);

        if (totalConfigs > 0) {
            EGLConfig* allConfigs = new EGLConfig[totalConfigs];
            s_eglGetConfigs(s_display, allConfigs, totalConfigs, &totalConfigs);

            EGLConfig bestConfig = nullptr;
            int bestScore = -1;

            for (EGLint i = 0; i < totalConfigs; i++) {
                EGLint surfType = 0, rSize = 0, gSize = 0, bSize = 0, aSize = 0, bufSize = 0;
                s_eglGetConfigAttrib(s_display, allConfigs[i], EGL_SURFACE_TYPE, &surfType);
                s_eglGetConfigAttrib(s_display, allConfigs[i], EGL_RED_SIZE, &rSize);
                s_eglGetConfigAttrib(s_display, allConfigs[i], EGL_GREEN_SIZE, &gSize);
                s_eglGetConfigAttrib(s_display, allConfigs[i], EGL_BLUE_SIZE, &bSize);
                s_eglGetConfigAttrib(s_display, allConfigs[i], EGL_ALPHA_SIZE, &aSize);
                s_eglGetConfigAttrib(s_display, allConfigs[i], 0x3020 /*EGL_BUFFER_SIZE*/, &bufSize);

                // Print first 10 configs with return value checking
                if (i < 10) {
                    EGLint configId = -1;
                    EGLBoolean ret = s_eglGetConfigAttrib(s_display, allConfigs[i], 0x3028 /*EGL_CONFIG_ID*/, &configId);
                    fprintf(stderr, "  Config[%d]: ptr=%p, id=%d, ret=%d, surfType=0x%04X, RGBA=%d/%d/%d/%d, bufSize=%d\n",
                            i, allConfigs[i], configId, ret, surfType, rSize, gSize, bSize, aSize, bufSize);
                }

                if (surfType & EGL_PBUFFER_BIT) {
                    // Score: prefer RGBA8 (8/8/8/8 = score 32), then any with more bits
                    int score = rSize + gSize + bSize + aSize;
                    if (rSize == 8 && gSize == 8 && bSize == 8) score += 100; // strong preference
                    if (aSize == 8) score += 50;
                    if (score > bestScore) {
                        bestScore = score;
                        bestConfig = allConfigs[i];
                        fprintf(stderr, "  -> candidate: score=%d\n", score);
                    }
                }
            }

            if (bestConfig) {
                s_config = bestConfig;
                EGLint rSize = 0, gSize = 0, bSize = 0, aSize = 0;
                s_eglGetConfigAttrib(s_display, s_config, EGL_RED_SIZE, &rSize);
                s_eglGetConfigAttrib(s_display, s_config, EGL_GREEN_SIZE, &gSize);
                s_eglGetConfigAttrib(s_display, s_config, EGL_BLUE_SIZE, &bSize);
                s_eglGetConfigAttrib(s_display, s_config, EGL_ALPHA_SIZE, &aSize);
                fprintf(stderr, "[egl_pbuffer] Strategy 3: picked best config RGBA=%d/%d/%d/%d (score=%d)\n",
                        rSize, gSize, bSize, aSize, bestScore);
                delete[] allConfigs;
                return true;
            }
            delete[] allConfigs;
        }
    }

    fprintf(stderr, "[egl_pbuffer] No suitable EGL config found\n");
    return false;
}

// ============================================================================
// Implementation
// ============================================================================

bool createPbufferSurfaces(uint32_t count) {
    if (count > MAX_PBUFFER_SURFACES) {
        fprintf(stderr, "[egl_pbuffer] count %u exceeds max %d\n", count, MAX_PBUFFER_SURFACES);
        return false;
    }

    if (!resolveEglFunctions()) return false;

    // Get the EGL display — MUST use eglGetPlatformDisplayEXT with ANGLE D3D11
    // to get the same display that Chromium/ANGLE uses internally.
    // eglGetDisplay(EGL_DEFAULT_DISPLAY) returns a different display with bogus configs!
    s_display = nullptr;

    // Strategy A: eglGetPlatformDisplayEXT with D3D11 (matches Chromium's display)
    if (s_eglGetPlatformDisplayEXT) {
        const EGLint displayAttribs[] = {
            EGL_PLATFORM_ANGLE_TYPE_ANGLE, (EGLint)EGL_PLATFORM_ANGLE_TYPE_D3D11_ANGLE,
            EGL_NONE
        };
        s_display = s_eglGetPlatformDisplayEXT(
            EGL_PLATFORM_ANGLE_ANGLE,
            nullptr, // EGL_DEFAULT_DISPLAY
            displayAttribs
        );
        if (s_display) {
            fprintf(stderr, "[egl_pbuffer] Got ANGLE D3D11 platform display: %p\n", s_display);
        }
    }

    // Strategy B: try current display (works if called from GPU thread)
    if (!s_display && s_eglGetCurrentDisplay) {
        s_display = s_eglGetCurrentDisplay();
        if (s_display) {
            fprintf(stderr, "[egl_pbuffer] Got current display: %p\n", s_display);
        }
    }

    // Strategy C: fallback to default display
    if (!s_display && s_eglGetDisplay_fn) {
        s_display = (EGLDisplay)s_eglGetDisplay_fn(0 /*EGL_DEFAULT_DISPLAY*/);
        if (s_display) {
            fprintf(stderr, "[egl_pbuffer] Got default display: %p (may have wrong configs!)\n", s_display);
        }
    }

    if (!s_display) {
        fprintf(stderr, "[egl_pbuffer] EGL display not available\n");
        return false;
    }

    // Ensure display is initialized
    if (s_eglInitialize) {
        EGLint major = 0, minor = 0;
        if (!s_eglInitialize(s_display, &major, &minor)) {
            EGLint err = s_eglGetError ? s_eglGetError() : 0;
            fprintf(stderr, "[egl_pbuffer] eglInitialize failed (error=0x%04X)\n", err);
            return false;
        }
        fprintf(stderr, "[egl_pbuffer] EGL initialized: %d.%d, display=%p\n", major, minor, s_display);
    }

    // Choose a suitable config
    if (!chooseConfig()) return false;

    // Debug: print chosen config details
    if (s_eglGetConfigAttrib && s_config) {
        EGLint rSize = 0, gSize = 0, bSize = 0, aSize = 0, surfType = 0, rendType = 0, bufSize = 0;
        s_eglGetConfigAttrib(s_display, s_config, EGL_RED_SIZE, &rSize);
        s_eglGetConfigAttrib(s_display, s_config, EGL_GREEN_SIZE, &gSize);
        s_eglGetConfigAttrib(s_display, s_config, EGL_BLUE_SIZE, &bSize);
        s_eglGetConfigAttrib(s_display, s_config, EGL_ALPHA_SIZE, &aSize);
        s_eglGetConfigAttrib(s_display, s_config, EGL_SURFACE_TYPE, &surfType);
        s_eglGetConfigAttrib(s_display, s_config, 0x3040 /*EGL_RENDERABLE_TYPE*/, &rendType);
        s_eglGetConfigAttrib(s_display, s_config, 0x3020 /*EGL_BUFFER_SIZE*/, &bufSize);
        fprintf(stderr, "[egl_pbuffer] Config: RGBA=%d/%d/%d/%d bufSize=%d surfType=0x%X rendType=0x%X\n",
                rSize, gSize, bSize, aSize, bufSize, surfType, rendType);
    }

    // Clean up previous surfaces
    destroyPbufferSurfaces();

    // Create our own EGL context for this thread (GPU thread context is on a different thread)
    if (!s_ownContext && s_eglCreateContext) {
        const EGLint contextAttribs[] = {
            0x3098 /*EGL_CONTEXT_CLIENT_VERSION*/, 2,
            EGL_NONE
        };
        s_ownContext = s_eglCreateContext(s_display, s_config, EGL_NO_CONTEXT, contextAttribs);
        if (s_ownContext) {
            fprintf(stderr, "[egl_pbuffer] Created own EGL context: %p\n", s_ownContext);
        } else {
            EGLint err = s_eglGetError ? s_eglGetError() : 0;
            fprintf(stderr, "[egl_pbuffer] eglCreateContext failed (error=0x%04X)\n", err);
            return false;
        }
    }

    uint32_t w = getSharedTextureWidth();
    uint32_t h = getSharedTextureHeight();

    for (uint32_t i = 0; i < count; i++) {
        void* shareHandle = getShareHandle(i);
        if (!shareHandle) {
            fprintf(stderr, "[egl_pbuffer] No share handle for texture %u\n", i);
            destroyPbufferSurfaces();
            return false;
        }

        // Minimal surface attributes — ANGLE infers size from the D3D11 texture
        const EGLint surfAttribs[] = {
            EGL_WIDTH, (EGLint)w,
            EGL_HEIGHT, (EGLint)h,
            EGL_NONE
        };

        EGLSurface pbuf = s_eglCreatePbufferFromClientBuffer(
            s_display,
            EGL_D3D_TEXTURE_2D_SHARE_HANDLE_ANGLE,
            (EGLClientBuffer)shareHandle,
            s_config,
            surfAttribs
        );

        if (pbuf == EGL_NO_SURFACE) {
            EGLint err = s_eglGetError ? s_eglGetError() : 0;
            fprintf(stderr, "[egl_pbuffer] eglCreatePbufferFromClientBuffer[%u] failed (error=0x%04X)\n", i, err);
            destroyPbufferSurfaces();
            return false;
        }

        s_pbuffers[i] = pbuf;
        fprintf(stderr, "[egl_pbuffer] Pbuffer[%u] created: %ux%u, surface=%p\n",
                i, w, h, pbuf);
    }

    s_pbufferCount = count;
    fprintf(stderr, "[egl_pbuffer] Created %u pbuffer surfaces\n", count);
    return true;
}

bool makePbufferCurrent(uint32_t index) {
    if (index >= s_pbufferCount || !s_pbuffers[index]) {
        fprintf(stderr, "[egl_pbuffer] Invalid pbuffer index %u\n", index);
        return false;
    }

    // Save current state (first time only)
    if (!s_surfaceSaved) {
        s_savedDraw = s_eglGetCurrentSurface(EGL_DRAW);
        s_savedRead = s_eglGetCurrentSurface(EGL_READ);
        s_savedContext = s_eglGetCurrentContext();
        s_surfaceSaved = true;
    }

    // Use our own context (created on this thread) — GPU thread's context is on a different thread
    EGLContext ctx = s_ownContext;
    if (!ctx) {
        // Fallback: try current thread's context
        ctx = s_eglGetCurrentContext();
    }
    if (!ctx) {
        fprintf(stderr, "[egl_pbuffer] No EGL context available\n");
        return false;
    }

    EGLBoolean ok = s_eglMakeCurrent(s_display, s_pbuffers[index], s_pbuffers[index], ctx);
    if (!ok) {
        EGLint err = s_eglGetError ? s_eglGetError() : 0;
        fprintf(stderr, "[egl_pbuffer] eglMakeCurrent(pbuffer[%u]) failed (error=0x%04X)\n", index, err);
        return false;
    }

    return true;
}

bool restoreDefaultSurface() {
    if (!s_surfaceSaved) {
        // No saved state — just unbind current
        if (s_eglMakeCurrent && s_display) {
            s_eglMakeCurrent(s_display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
        }
        fprintf(stderr, "[egl_pbuffer] Unbound EGL context (no previous state)\n");
        return true;
    }

    EGLBoolean ok;
    if (s_savedContext) {
        ok = s_eglMakeCurrent(s_display, s_savedDraw, s_savedRead, s_savedContext);
    } else {
        ok = s_eglMakeCurrent(s_display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    }
    s_surfaceSaved = false;

    if (!ok) {
        EGLint err = s_eglGetError ? s_eglGetError() : 0;
        fprintf(stderr, "[egl_pbuffer] eglMakeCurrent(restore) failed (error=0x%04X)\n", err);
        return false;
    }

    fprintf(stderr, "[egl_pbuffer] Restored original EGL surface\n");
    return true;
}

void destroyPbufferSurfaces() {
    // Unbind before destroying
    if (s_display && s_eglMakeCurrent) {
        s_eglMakeCurrent(s_display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    }

    for (uint32_t i = 0; i < MAX_PBUFFER_SURFACES; i++) {
        if (s_pbuffers[i]) {
            if (s_display && s_eglDestroySurface) s_eglDestroySurface(s_display, s_pbuffers[i]);
            s_pbuffers[i] = nullptr;
        }
    }

    if (s_ownContext && s_display && s_eglDestroyContext) {
        s_eglDestroyContext(s_display, s_ownContext);
        s_ownContext = nullptr;
    }

    s_pbufferCount = 0;
    s_surfaceSaved = false;
    fprintf(stderr, "[egl_pbuffer] Destroyed all pbuffer surfaces\n");
}

// ============================================================================
// GL rendering (for POC testing + future use)
// ============================================================================

typedef void   (EGLAPIENTRY *pfn_glClearColor)(float r, float g, float b, float a);
typedef void   (EGLAPIENTRY *pfn_glClear)(unsigned int mask);
typedef void   (EGLAPIENTRY *pfn_glFlush)(void);
typedef void   (EGLAPIENTRY *pfn_glFinish)(void);
typedef void   (EGLAPIENTRY *pfn_glViewport)(int x, int y, int width, int height);
typedef unsigned int (EGLAPIENTRY *pfn_glGetError)(void);

static pfn_glClearColor  s_glClearColor = nullptr;
static pfn_glClear       s_glClear = nullptr;
static pfn_glFlush       s_glFlush = nullptr;
static pfn_glFinish      s_glFinish = nullptr;
static pfn_glViewport    s_glViewport = nullptr;
static pfn_glGetError    s_glGetError = nullptr;
static bool s_glResolved = false;

static bool resolveGlFunctions() {
    if (s_glResolved) return (s_glClearColor != nullptr);
    s_glResolved = true;

    HMODULE glesLib = LoadLibraryA("libGLESv2.dll");
    if (!glesLib) {
        fprintf(stderr, "[egl_pbuffer] Failed to load libGLESv2.dll\n");
        return false;
    }

    s_glClearColor = (pfn_glClearColor)GetProcAddress(glesLib, "glClearColor");
    s_glClear = (pfn_glClear)GetProcAddress(glesLib, "glClear");
    s_glFlush = (pfn_glFlush)GetProcAddress(glesLib, "glFlush");
    s_glFinish = (pfn_glFinish)GetProcAddress(glesLib, "glFinish");
    s_glViewport = (pfn_glViewport)GetProcAddress(glesLib, "glViewport");
    s_glGetError = (pfn_glGetError)GetProcAddress(glesLib, "glGetError");

    if (!s_glClearColor || !s_glClear || !s_glFlush) {
        fprintf(stderr, "[egl_pbuffer] Failed to resolve GL functions\n");
        return false;
    }
    fprintf(stderr, "[egl_pbuffer] GL functions resolved (libGLESv2.dll)\n");
    return true;
}

bool renderSolidColor(float r, float g, float b, float a) {
    if (!resolveGlFunctions()) return false;

    uint32_t w = getSharedTextureWidth();
    uint32_t h = getSharedTextureHeight();

    if (s_glViewport) s_glViewport(0, 0, (int)w, (int)h);
    s_glClearColor(r, g, b, a);
    s_glClear(0x00004000 /* GL_COLOR_BUFFER_BIT */);
    if (s_glFinish) s_glFinish();  // ensure rendering completes before we read back

    if (s_glGetError) {
        unsigned int err = s_glGetError();
        if (err != 0) {
            fprintf(stderr, "[egl_pbuffer] GL error after render: 0x%04X\n", err);
            return false;
        }
    }
    return true;
}

// ============================================================================
// N-API wrappers
// ============================================================================

Napi::Value CreatePbufferSurfaces(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    uint32_t count = info[0].As<Napi::Number>().Uint32Value();
    bool ok = createPbufferSurfaces(count);

    Napi::Object result = Napi::Object::New(env);
    result.Set("ok", Napi::Boolean::New(env, ok));
    if (ok) result.Set("count", Napi::Number::New(env, count));
    return result;
}

Napi::Value MakePbufferCurrent(const Napi::CallbackInfo& info) {
    uint32_t index = info[0].As<Napi::Number>().Uint32Value();
    return Napi::Boolean::New(info.Env(), makePbufferCurrent(index));
}

Napi::Value RestoreDefaultSurface(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), restoreDefaultSurface());
}

Napi::Value DestroyPbufferSurfaces(const Napi::CallbackInfo& info) {
    destroyPbufferSurfaces();
    return Napi::Boolean::New(info.Env(), true);
}

Napi::Value RenderSolidColor(const Napi::CallbackInfo& info) {
    float r = info[0].As<Napi::Number>().FloatValue();
    float g = info[1].As<Napi::Number>().FloatValue();
    float b = info[2].As<Napi::Number>().FloatValue();
    float a = info.Length() > 3 ? info[3].As<Napi::Number>().FloatValue() : 1.0f;
    return Napi::Boolean::New(info.Env(), renderSolidColor(r, g, b, a));
}
