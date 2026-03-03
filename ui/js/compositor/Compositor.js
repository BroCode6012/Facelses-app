/**
 * Compositor.js — WYSIWYG WebGL2 Compositor Engine
 *
 * Single render(frameIndex) method that produces identical output for:
 *   1) Real-time preview (renders to on-screen canvas via requestAnimationFrame)
 *   2) Offline export (renders frame-by-frame, readPixels -> FFmpeg)
 *
 * Compositing pipeline per frame:
 *   1. Clear to black
 *   2. For each active video/image scene (sorted by track): upload texture, blit
 *   3. If transition active: blend via TransitionRenderer shader
 *   4. For each active MG overlay: render Canvas2D -> texture, alpha-blend
 *   5. (Export mode): readPixels -> Uint8Array
 */

class Compositor {
    /**
     * @param {HTMLCanvasElement} canvas - The target canvas element
     * @param {object} opts - { width, height, fps }
     */
    constructor(canvas, opts) {
        this.canvas = canvas;
        this.width = (opts && opts.width) || 1920;
        this.height = (opts && opts.height) || 1080;
        this.fps = (opts && opts.fps) || 30;

        this.gl = null;
        this.sceneGraph = null;
        this.textureManager = null;
        this.mgRenderer = null;
        this.transitionRenderer = null;

        // Video elements keyed by scene index
        this._videoElements = {};
        // Cached media URLs keyed by scene index
        this._mediaUrls = {};
        // URL resolver function (async: sceneIndex -> url)
        this._urlResolver = null;
        // Script context from plan
        this._scriptContext = null;

        // Shader programs
        this._blitProgram = null;
        this._quadVAO = null;

        this._initialized = false;
        this._currentFrame = -1;
        this._exporting = false;

        // Flip buffer for export (readPixels returns bottom-up)
        this._flipBuf = null;

        // EXPORT-ONLY: WebCodecs VideoFrame overrides for optimized export.
        // - null during preview (default) — _getSceneTexture ignores it
        // - Set to Map<sceneIndex, VideoFrame> ONLY by ExportPipeline._runOptimizedFrameLoop()
        // - Guarded by this._exporting in _getSceneTexture (never checked in preview)
        // - Cleared to null by _resetVideosForPreview() and ExportPipeline finally block
        this._exportFrameSources = null;

        // PBO async readback (export-only, initialized by initPBOs)
        this._pbos = null;           // Array of WebGLBuffer
        this._pboCount = 4;
        this._pboWriteIndex = 0;     // next PBO to write into
        this._pboFrameBytes = 0;     // w * h * 4
        this._pboReady = false;
    }

    // ========================================================================
    // LIFECYCLE
    // ========================================================================

    /**
     * Initialize WebGL2 context, compile shaders, allocate buffers.
     */
    init() {
        if (this._initialized) return;

        this.canvas.width = this.width;
        this.canvas.height = this.height;

        const gl = this.canvas.getContext('webgl2', {
            alpha: false,              // Opaque canvas (composites on black)
            premultipliedAlpha: false,
            preserveDrawingBuffer: true,  // Required for readPixels in export
            antialias: false,
            powerPreference: 'high-performance',
        });

        if (!gl) {
            throw new Error('WebGL2 not available — cannot initialize compositor');
        }
        this.gl = gl;

        // Compile blit shader
        const { QUAD_VERT, BLIT_FRAG, ShaderProgram } = window.ShaderLib;
        this._blitProgram = new ShaderProgram(gl, QUAD_VERT, BLIT_FRAG);

        // Create fullscreen quad VAO
        this._quadVAO = this._createQuadVAO(gl);

        // Sub-components
        this.textureManager = new TextureManager(gl);
        this.mgRenderer = new MGRenderer(this.textureManager, this.fps);
        this.transitionRenderer = new TransitionRenderer(gl);
        this.transitionRenderer.init();

        this._initialized = true;
        console.log('[Compositor] Initialized WebGL2 engine', this.width, 'x', this.height, '@', this.fps, 'fps');
    }

    /**
     * Destroy all GPU resources and video elements.
     */
    destroy() {
        if (this.textureManager) this.textureManager.releaseAll();
        if (this.transitionRenderer) this.transitionRenderer.destroy();
        if (this._blitProgram) this._blitProgram.destroy();
        if (this._quadVAO && this.gl) {
            this.gl.deleteVertexArray(this._quadVAO);
        }
        if (this.mgRenderer) this.mgRenderer.destroy();

        // Pause and release video elements
        for (const key of Object.keys(this._videoElements)) {
            const vid = this._videoElements[key];
            vid.pause();
            vid.src = '';
            vid.load();
        }
        this._videoElements = {};
        this._mediaUrls = {};

        this.destroyPBOs();
        this.gl = null;
        this._initialized = false;
        console.log('[Compositor] Destroyed');
    }

    // ========================================================================
    // PLAN LOADING
    // ========================================================================

    /**
     * Load a video-plan.json into the compositor.
     * Creates SceneGraph, preloads video elements.
     *
     * @param {object} plan - The video-plan.json object
     * @param {function} urlResolver - async (sceneIndex, extension) => url string
     */
    async loadPlan(plan, urlResolver) {
        if (!this._initialized) this.init();

        this._urlResolver = urlResolver;
        this._scriptContext = plan.scriptContext || {};
        this.fps = plan.fps || this.fps;

        // Build frame-based scene graph
        this.sceneGraph = new SceneGraph(this.fps);
        this.sceneGraph.loadFromPlan(plan);

        // Preload video/image elements for all non-MG scenes
        const mediaScenes = this.sceneGraph.scenes.filter(s => !s.isMGScene && s.mediaType !== 'motion-graphic');
        await this._preloadMedia(mediaScenes);

        console.log('[Compositor] Plan loaded:', this.sceneGraph.totalFrames, 'frames,',
            mediaScenes.length, 'media scenes,', this.sceneGraph.motionGraphics.length, 'MG overlays');
    }

    /**
     * Create hidden <video>/<img> elements for media scenes and start loading.
     */
    async _preloadMedia(scenes) {
        // Release old elements (remove from DOM too)
        for (const key of Object.keys(this._videoElements)) {
            const el = this._videoElements[key];
            if (el instanceof HTMLVideoElement) {
                el.pause();
                el.src = '';
                el.load();
                if (el.parentNode) el.parentNode.removeChild(el);
            }
        }
        this._videoElements = {};
        this._mediaUrls = {};

        // First pass: resolve all URLs in parallel
        const urlMap = {};
        const urlPromises = scenes.map(async (scene) => {
            const idx = scene.index;
            if (idx == null) return;
            const ext = scene.mediaExtension || '.mp4';
            const url = await this._resolveUrl(idx, ext);
            if (url) urlMap[idx] = { url, ext };
        });
        await Promise.all(urlPromises);

        // Second pass: create elements and wait for load
        // Load images in parallel (lightweight), but batch videos to avoid
        // overwhelming browser with too many simultaneous video loads
        const imagePromises = [];
        const videoScenes = [];

        for (const scene of scenes) {
            const idx = scene.index;
            if (idx == null || !urlMap[idx]) continue;
            const { url, ext } = urlMap[idx];
            const isImage = scene.mediaType === 'image' || /\.(jpg|jpeg|png|webp|gif)$/i.test(ext);

            this._mediaUrls[idx] = url;

            if (isImage) {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                this._videoElements[idx] = img;
                imagePromises.push(new Promise(resolve => {
                    img.onload = resolve;
                    img.onerror = () => { console.warn(`[Compositor] Failed to load image for scene ${idx}`); resolve(); };
                    img.src = url;
                    setTimeout(resolve, 5000);
                }));
            } else {
                videoScenes.push({ scene, url, idx });
            }
        }

        // Create all video elements upfront so they start loading in parallel
        for (const { scene, url, idx } of videoScenes) {
            const video = document.createElement('video');
            video.muted = true;
            video.preload = 'auto';
            video.playsInline = true;
            video.crossOrigin = 'anonymous';
            video.style.display = 'none';
            document.body.appendChild(video);
            this._videoElements[idx] = video;
            video.src = url;
        }

        // Wait for all videos to reach canplaythrough (fully buffered for local files)
        const videoPromises = videoScenes.map(({ idx }) => {
            const video = this._videoElements[idx];
            return new Promise(resolve => {
                if (video.readyState >= 3) { resolve(); return; } // HAVE_FUTURE_DATA or better
                let resolved = false;
                const done = () => {
                    if (resolved) return;
                    resolved = true;
                    video.removeEventListener('canplaythrough', onReady);
                    video.removeEventListener('loadeddata', onFallback);
                    video.removeEventListener('error', onError);
                    clearTimeout(timer);
                    resolve();
                };
                const onReady = () => done();
                const onFallback = () => {
                    // canplaythrough might not fire for some codecs, accept loadeddata after a delay
                    setTimeout(done, 500);
                };
                const onError = () => {
                    console.warn(`[Compositor] Failed to load video for scene ${idx}`);
                    done();
                };
                video.addEventListener('canplaythrough', onReady);
                video.addEventListener('loadeddata', onFallback);
                video.addEventListener('error', onError);
                const timer = setTimeout(() => {
                    console.warn(`[Compositor] Timeout loading video for scene ${idx} (readyState=${video.readyState})`);
                    done();
                }, 20000);
            });
        });

        // Wait for all images and videos
        await Promise.all([...imagePromises, ...videoPromises]);
        console.log(`[Compositor] Preloaded ${imagePromises.length} images and ${videoScenes.length} videos`);
    }

    async _resolveUrl(sceneIndex, ext) {
        if (this._urlResolver) {
            try {
                return await this._urlResolver(sceneIndex, ext);
            } catch (e) {
                console.warn('[Compositor] Failed to resolve URL for scene', sceneIndex, e);
                return null;
            }
        }
        return null;
    }

    // ========================================================================
    // RENDER
    // ========================================================================

    /**
     * Render at a given time in seconds (convenience for preview playback).
     */
    renderAtTime(timeSeconds) {
        const frame = Math.round(timeSeconds * this.fps);
        this.renderFrame(frame);
    }

    /**
     * Core render method. Composites all active layers for the given frame.
     * This is THE single entry point for both preview and export.
     */
    renderFrame(frame) {
        if (!this._initialized || !this.gl || !this.sceneGraph) return;
        const gl = this.gl;
        this._currentFrame = frame;

        gl.viewport(0, 0, this.width, this.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // 1. Get active scenes at this frame
        const activeScenes = this.sceneGraph.getActiveScenesAtFrame(frame);

        // 2. Check for transitions
        const transition = this.sceneGraph.getTransitionAtFrame(frame);

        // 3. Render scenes
        if (transition && transition.sceneA && transition.sceneB) {
            // Transition active: need textures from both scenes
            const texA = this._getSceneTexture(transition.sceneA, frame);
            const texB = this._getSceneTexture(transition.sceneB, frame);

            if (texA && texB) {
                this.transitionRenderer.render(
                    texA.texture, texB.texture,
                    transition.progress, transition.type,
                    () => this._drawQuad()
                );
            } else {
                // Fallback: render whichever is available
                this._renderSceneTexture(texA || texB, 1.0);
            }

            // Also render non-transitioning scenes on other tracks
            for (const { scene, trackNum } of activeScenes) {
                if (scene.index === transition.sceneA.index || scene.index === transition.sceneB.index) continue;
                const tex = this._getSceneTexture(scene, frame);
                if (tex) {
                    gl.enable(gl.BLEND);
                    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                    this._renderSceneTexture(tex, 1.0, scene);
                    gl.disable(gl.BLEND);
                }
            }
        } else {
            // No transition: render each scene by track order
            for (let i = 0; i < activeScenes.length; i++) {
                const { scene, trackNum } = activeScenes[i];

                // Handle fullscreen MG scenes (isMGScene on track-3)
                if (scene.isMGScene || scene.mediaType === 'motion-graphic') {
                    // Render the MG as a fullscreen graphic
                    const localFrame = frame - scene._startFrame;
                    const mgTex = this.mgRenderer.renderMG(scene, localFrame, this._scriptContext);
                    if (mgTex) {
                        if (i > 0) {
                            gl.enable(gl.BLEND);
                            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                        }
                        this._blitTexture(mgTex.texture, 1.0, 1, 1, 0, 0);
                        if (i > 0) gl.disable(gl.BLEND);
                    }
                    continue;
                }

                const tex = this._getSceneTexture(scene, frame);
                if (!tex) continue;

                if (i === 0) {
                    // First track: opaque blit (base layer)
                    this._renderSceneTexture(tex, 1.0, scene);
                } else {
                    // Upper tracks: alpha blend
                    gl.enable(gl.BLEND);
                    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                    this._renderSceneTexture(tex, 1.0, scene);
                    gl.disable(gl.BLEND);
                }
            }
        }

        // 4. Render overlay motion graphics
        const activeMGs = this.sceneGraph.getActiveMGsAtFrame(frame);
        if (activeMGs.length > 0) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

            for (const { mg, localFrame } of activeMGs) {
                const mgTex = this.mgRenderer.renderMG(mg, localFrame, this._scriptContext);
                if (mgTex) {
                    this._blitTexture(mgTex.texture, 1.0, 1, 1, 0, 0);
                }
            }

            gl.disable(gl.BLEND);
        }
    }

    // ========================================================================
    // TEXTURE & BLIT HELPERS
    // ========================================================================

    /**
     * Get/update the texture for a scene at the given frame.
     * For videos: uploads the current video frame as a texture.
     * For images: uses cached texture (or creates one).
     */
    _getSceneTexture(scene, frame) {
        const idx = scene.index;
        const texId = `scene-${idx}`;

        // EXPORT-ONLY: use WebCodecs VideoFrame if provided by optimized export loop
        if (this._exporting && this._exportFrameSources && this._exportFrameSources.has(idx)) {
            const vf = this._exportFrameSources.get(idx);
            if (vf) return this.textureManager.createOrUpdate(texId, vf);
        }

        const el = this._videoElements[idx];
        if (!el) return null;

        if (el instanceof HTMLVideoElement) {
            // Sync video time for preview mode
            if (!this._exporting && el.readyState >= 2) {
                const localTime = (frame - scene._startFrame) / this.fps;
                const mediaOffset = scene.mediaOffset || 0;
                const targetTime = localTime + mediaOffset;
                // Only seek if drift is significant (avoid constant seeks)
                if (Math.abs(el.currentTime - targetTime) > 0.1) {
                    el.currentTime = targetTime;
                }
            }
            return this.textureManager.createOrUpdate(texId, el);
        } else if (el instanceof HTMLImageElement) {
            if (el.naturalWidth > 0) {
                return this.textureManager.createOrUpdate(texId, el);
            }
        }

        return this.textureManager.get(texId);
    }

    /**
     * Render a scene texture with fit-mode transform (cover/contain + scale/offset).
     */
    _renderSceneTexture(texEntry, opacity, scene) {
        if (!texEntry || !texEntry.texture) return;

        // Compute fit-mode transform
        let scaleX = 1, scaleY = 1, offsetX = 0, offsetY = 0;

        if (scene) {
            const srcAspect = texEntry.width / texEntry.height;
            const dstAspect = this.width / this.height;
            const fitMode = scene.fitMode || 'cover';

            if (fitMode === 'cover') {
                if (srcAspect > dstAspect) {
                    // Source wider than dest: zoom in on X so Y fills, crops sides
                    scaleX = srcAspect / dstAspect;
                } else {
                    // Source taller than dest: zoom in on Y so X fills, crops top/bottom
                    scaleY = dstAspect / srcAspect;
                }
            } else if (fitMode === 'contain') {
                if (srcAspect > dstAspect) {
                    // Source wider: letterbox top/bottom
                    scaleY = dstAspect / srcAspect;
                } else {
                    // Source taller: pillarbox sides
                    scaleX = srcAspect / dstAspect;
                }
            }

            // Apply user scale
            const userScale = scene.scale || 1;
            scaleX *= userScale;
            scaleY *= userScale;

            // Apply position offset (posX/posY are percentages)
            offsetX = (scene.posX || 0) / 100;
            offsetY = (scene.posY || 0) / 100;
        }

        this._blitTexture(texEntry.texture, opacity, scaleX, scaleY, offsetX, offsetY);
    }

    /**
     * Blit a texture to the current framebuffer with transform and opacity.
     */
    _blitTexture(texture, opacity, scaleX, scaleY, offsetX, offsetY) {
        this._blitProgram.use();
        this._blitProgram.setTexture('u_texture', 0, texture);
        this._blitProgram.set1f('u_opacity', opacity);
        this._blitProgram.set4f('u_transform', scaleX, scaleY, offsetX, offsetY);
        this._drawQuad();
    }

    /**
     * Draw the fullscreen quad.
     */
    _drawQuad() {
        const gl = this.gl;
        gl.bindVertexArray(this._quadVAO);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
    }

    /**
     * Create a VAO with a fullscreen quad (2 triangles as a triangle strip).
     */
    _createQuadVAO(gl) {
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);

        const positions = new Float32Array([
            -1, -1,  // bottom-left
             1, -1,  // bottom-right
            -1,  1,  // top-left
             1,  1,  // top-right
        ]);

        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

        // a_position is at location 0 (set in vertex shader)
        const posLoc = gl.getAttribLocation(this._blitProgram.program, 'a_position');
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        gl.bindVertexArray(null);
        return vao;
    }

    // ========================================================================
    // EXPORT HELPERS
    // ========================================================================

    /**
     * Read pixels from the current framebuffer as a Uint8Array (RGBA).
     * Flips vertically (WebGL is bottom-up, video is top-down).
     */
    readPixels() {
        const gl = this.gl;
        const w = this.width;
        const h = this.height;
        const size = w * h * 4;

        if (!this._flipBuf || this._flipBuf.length !== size) {
            this._flipBuf = new Uint8Array(size);
        }

        const pixels = new Uint8Array(size);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        // Flip vertically (swap rows)
        const rowSize = w * 4;
        for (let y = 0; y < h; y++) {
            const srcOffset = y * rowSize;
            const dstOffset = (h - 1 - y) * rowSize;
            this._flipBuf.set(pixels.subarray(srcOffset, srcOffset + rowSize), dstOffset);
        }

        return this._flipBuf;
    }

    /**
     * Read pixels directly into a caller-provided Uint8Array (RGBA, top-down).
     * Avoids allocating a new buffer per frame — ideal for ring-buffer export.
     *
     * Reads GL framebuffer into `target`, then flips rows in-place using a
     * single-row temp buffer (~7.5 KB for 1920px width).
     *
     * @param {Uint8Array} target - Pre-allocated buffer, must be width*height*4 bytes
     */
    readPixelsInto(target) {
        const gl = this.gl;
        const w = this.width;
        const h = this.height;
        const rowSize = w * 4;

        // GPU → CPU: one copy directly into the caller's buffer
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, target);

        // In-place vertical flip using a single-row temp buffer
        if (!this._rowBuf || this._rowBuf.length !== rowSize) {
            this._rowBuf = new Uint8Array(rowSize);
        }
        const halfH = h >>> 1;
        for (let y = 0; y < halfH; y++) {
            const top = y * rowSize;
            const bot = (h - 1 - y) * rowSize;
            // swap top row ↔ bottom row via temp
            this._rowBuf.set(target.subarray(top, top + rowSize));
            target.set(target.subarray(bot, bot + rowSize), top);
            target.set(this._rowBuf, bot);
        }
    }

    // ========================================================================
    // PBO ASYNC READBACK (export-only)
    // ========================================================================

    /**
     * Create 3 PBOs for async readback. Call once at export start.
     * @param {number} width
     * @param {number} height
     * @returns {boolean} true if PBOs created successfully
     */
    initPBOs(width, height) {
        const gl = this.gl;
        if (!gl || !(gl instanceof WebGL2RenderingContext)) {
            console.warn('[WebGL Export] initPBOs FAILED: not a WebGL2 context');
            return false;
        }

        const frameBytes = width * height * 4;
        this._pboFrameBytes = frameBytes;
        this._pboCount = 4;
        this._pboWriteIndex = 0;
        this._pbos = [];

        try {
            for (let i = 0; i < this._pboCount; i++) {
                const pbo = gl.createBuffer();
                if (!pbo) throw new Error(`Failed to create PBO ${i}`);
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
                gl.bufferData(gl.PIXEL_PACK_BUFFER, frameBytes, gl.STREAM_READ);
                this._pbos.push(pbo);
            }
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
            this._pboReady = true;
            console.log(`[WebGL Export] initPBOs SUCCESS: ${this._pboCount} PBOs, bytes=${frameBytes}`);
            return true;
        } catch (err) {
            console.warn(`[WebGL Export] initPBOs FAILED: ${err.message}`);
            this.destroyPBOs();
            return false;
        }
    }

    /**
     * Initiate async readPixels into the current PBO (non-blocking).
     * The GPU begins DMA transfer in the background.
     * @returns {number} PBO index written to, or -1 if not ready
     */
    readPixelsIntoPBO() {
        if (!this._pboReady) return -1;
        const gl = this.gl;
        const idx = this._pboWriteIndex;

        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._pbos[idx]);
        // When PIXEL_PACK_BUFFER is bound, last param is byte offset into PBO (not a pointer)
        gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

        this._pboWriteIndex = (idx + 1) % this._pboCount;
        return idx;
    }

    /**
     * Read back data from a PBO into a CPU buffer + vertical flip.
     * Blocks until DMA is complete (should already be done if 1+ frame has passed).
     * @param {number} pboIndex - Which PBO to read from
     * @param {Uint8Array} target - Pre-allocated buffer from pool
     */
    readBackPBO(pboIndex, target) {
        const gl = this.gl;
        const w = this.width;
        const h = this.height;
        const rowSize = w * 4;

        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._pbos[pboIndex]);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, target, 0, this._pboFrameBytes);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

        // In-place vertical flip — identical to readPixelsInto
        if (!this._rowBuf || this._rowBuf.length !== rowSize) {
            this._rowBuf = new Uint8Array(rowSize);
        }
        const halfH = h >>> 1;
        for (let y = 0; y < halfH; y++) {
            const top = y * rowSize;
            const bot = (h - 1 - y) * rowSize;
            this._rowBuf.set(target.subarray(top, top + rowSize));
            target.set(target.subarray(bot, bot + rowSize), top);
            target.set(this._rowBuf, bot);
        }
    }

    /**
     * Create a GPU fence after readPixelsIntoPBO to track DMA completion.
     * Call gl.flush() to ensure the fence is submitted to the GPU.
     * @returns {WebGLSync|null} Sync object, or null if not supported
     */
    createFence() {
        const gl = this.gl;
        if (!gl || !gl.fenceSync) return null;
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        return sync;
    }

    /**
     * Wait for a GPU fence to be signaled, yielding to the event loop
     * between polls (no busy-wait). Deletes the sync object when done.
     * @param {WebGLSync} sync - Fence from createFence()
     * @param {number} [timeoutMs=1500] - Max wait before giving up
     * @returns {Promise<boolean>} true if fence was satisfied, false if timed out
     */
    async awaitFence(sync, timeoutMs) {
        if (!sync) return true;
        const gl = this.gl;
        if (!gl) return true; // context gone, sync is orphaned — proceed to readback
        const deadline = performance.now() + (timeoutMs || 1500);

        while (performance.now() < deadline) {
            const status = gl.clientWaitSync(sync, gl.SYNC_FLUSH_COMMANDS_BIT, 0);
            if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
                gl.deleteSync(sync);
                return true;
            }
            // Yield to event loop — let GPU finish DMA without blocking
            await new Promise(r => setTimeout(r, 0));
        }

        // Timed out — delete sync and proceed (getBufferSubData will stall if needed)
        console.warn('[Compositor] Fence timed out, proceeding with stall');
        gl.deleteSync(sync);
        return false;
    }

    /**
     * Delete all PBO buffers. Called at export end or on error.
     */
    destroyPBOs() {
        if (this._pbos && this.gl) {
            for (const pbo of this._pbos) {
                if (pbo) this.gl.deleteBuffer(pbo);
            }
        }
        this._pbos = null;
        this._pboReady = false;
        this._pboWriteIndex = 0;
        this._pboFrameBytes = 0;
    }

    /**
     * Compute a fast hash of the current framebuffer for WYSIWYG validation.
     * Uses FNV-1a sampling (every 64th byte for speed).
     */
    computeFrameHash() {
        const gl = this.gl;
        const pixels = new Uint8Array(this.width * this.height * 4);
        gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        let hash = 2166136261; // FNV offset basis
        for (let i = 0; i < pixels.length; i += 64) {
            hash ^= pixels[i];
            hash = Math.imul(hash, 16777619); // FNV prime
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
    }

    // ========================================================================
    // VIDEO PLAYBACK CONTROL (for preview mode)
    // ========================================================================

    /**
     * Start playing all active video elements (for preview).
     */
    playVideos(currentTimeSeconds) {
        for (const scene of (this.sceneGraph ? this.sceneGraph.scenes : [])) {
            const vid = this._videoElements[scene.index];
            if (!(vid instanceof HTMLVideoElement)) continue;

            const sceneStart = scene._startFrame / this.fps;
            const sceneEnd = scene._endFrame / this.fps;

            if (currentTimeSeconds >= sceneStart && currentTimeSeconds < sceneEnd) {
                const localTime = currentTimeSeconds - sceneStart + (scene.mediaOffset || 0);
                vid.currentTime = localTime;
                vid.play().catch(() => {});
            }
        }
    }

    /**
     * Pause all video elements.
     */
    pauseVideos() {
        for (const key of Object.keys(this._videoElements)) {
            const el = this._videoElements[key];
            if (el instanceof HTMLVideoElement) {
                el.pause();
            }
        }
    }

    /**
     * Seek a video element to a specific frame (for export mode).
     * Returns a promise that resolves when the seek is complete and frame is decoded.
     */
    async seekVideoToFrame(sceneIndex, frame) {
        const vid = this._videoElements[sceneIndex];
        if (!(vid instanceof HTMLVideoElement)) return;

        // If video hasn't loaded yet, wait for it (don't skip — causes black frames)
        if (vid.readyState < 2) {
            await new Promise((resolve) => {
                let resolved = false;
                const done = () => {
                    if (resolved) return;
                    resolved = true;
                    vid.removeEventListener('loadeddata', onLoaded);
                    vid.removeEventListener('error', onError);
                    clearTimeout(timer);
                    resolve();
                };
                const onLoaded = () => done();
                const onError = () => {
                    console.warn(`[Compositor] Video for scene ${sceneIndex} failed to load`);
                    done();
                };
                vid.addEventListener('loadeddata', onLoaded);
                vid.addEventListener('error', onError);
                // If already loaded by now (race), resolve immediately
                if (vid.readyState >= 2) { done(); return; }
                const timer = setTimeout(() => {
                    console.warn(`[Compositor] Timeout waiting for video scene ${sceneIndex} to load`);
                    done();
                }, 15000);
            });
            if (vid.readyState < 2) return; // Truly failed to load
        }

        const targetTime = frame / this.fps;

        // Skip seek if already at this exact time
        if (Math.abs(vid.currentTime - targetTime) < 0.001) return;

        // Register seeked listener BEFORE setting currentTime to avoid race condition
        await new Promise((resolve) => {
            let resolved = false;
            const done = () => {
                if (resolved) return;
                resolved = true;
                vid.removeEventListener('seeked', onSeeked);
                clearTimeout(timer);
                resolve();
            };
            const onSeeked = () => done();
            vid.addEventListener('seeked', onSeeked);
            // Set currentTime AFTER listener is registered
            vid.currentTime = targetTime;
            // Timeout fallback in case seeked never fires
            const timer = setTimeout(done, 500);
        });
    }

    /**
     * Reset video elements after export so preview works again.
     * Seeks all videos to time 0 and ensures they are ready for playback.
     */
    _resetVideosForPreview() {
        // Always clear export-only VideoFrame overrides
        this._exportFrameSources = null;

        for (const key of Object.keys(this._videoElements)) {
            const el = this._videoElements[key];
            if (el instanceof HTMLVideoElement) {
                el.pause();
                el.currentTime = 0;
            }
        }
        // Clear texture cache so next renderFrame uploads fresh frames
        if (this.textureManager) {
            for (const scene of (this.sceneGraph ? this.sceneGraph.scenes : [])) {
                if (!scene.isMGScene && scene.mediaType !== 'motion-graphic') {
                    this.textureManager.release(`scene-${scene.index}`);
                }
            }
        }
    }

    // ========================================================================
    // GETTERS
    // ========================================================================

    get currentFrame() { return this._currentFrame; }
    get totalFrames() { return this.sceneGraph ? this.sceneGraph.totalFrames : 0; }
    get isExporting() { return this._exporting; }
    get isInitialized() { return this._initialized; }
}

window.Compositor = Compositor;
