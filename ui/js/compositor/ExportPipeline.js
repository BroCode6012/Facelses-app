/**
 * ExportPipeline.js — Offline render loop for WebGL2 compositor export
 *
 * Drives the compositor frame-by-frame:
 *   renderFrame(f) -> readPixels() -> IPC to main process -> FFmpeg NVENC encode
 *
 * The main process spawns FFmpeg with raw RGBA pipe input and handles encoding.
 * Audio is muxed separately after all video frames are written.
 *
 * Two export paths:
 *   - Legacy: per-frame HTMLVideoElement seeking + RAF yield + sync readPixels + per-frame IPC
 *   - Optimized: WebCodecs sequential decode + PBO async readback + batched IPC
 */

// Batch size for IPC frame sending — reduces round-trips to main process.
// Each frame is ~8MB RGBA, so batch of 6 = ~50MB per IPC call.
// Override via window.EXPORT_BATCH_SIZE or env var; clamped to 1–8.
const EXPORT_BATCH_SIZE = Math.max(1, Math.min(8,
    parseInt(window.EXPORT_BATCH_SIZE || '6', 10) || 6
));

// Max PBO frames in-flight before draining. Independent of pboCount.
// pboCount (4) provides enough buffers to avoid wrap-around;
// this controls how many frames overlap GPU DMA with CPU readback.
const MAX_INFLIGHT_PBOS = 3;

class ExportPipeline {
    /**
     * @param {Compositor} compositor - The initialized compositor engine
     */
    constructor(compositor) {
        this.compositor = compositor;
        this._cancelled = false;
        this._progressCallback = null;
        this._running = false;
        // Ring buffer pool — initialized at export start
        this._pool = null;       // Array of Uint8Array
        this._poolSize = 0;
        this._poolIndex = 0;     // next slot to use (wraps around)
        // PBO async readback state
        this._pboEnabled = false;
    }

    /**
     * Register a progress callback.
     * @param {function} cb - (data: { percent, currentFrame, totalFrames, fps }) => void
     */
    onProgress(cb) {
        this._progressCallback = cb;
    }

    /**
     * Run the full export pipeline.
     *
     * @param {object} options - Export options
     * @param {number} options.width - Output width (default 1920)
     * @param {number} options.height - Output height (default 1080)
     * @param {number} options.fps - Frames per second (default 30)
     * @param {boolean} options.legacy - Force legacy export path (per-frame seek + RAF)
     * @returns {Promise<{success: boolean, outputPath?: string, error?: string}>}
     */
    async start(options) {
        if (this._running) {
            return { success: false, error: 'Export already in progress' };
        }

        const width = (options && options.width) || this.compositor.width;
        const height = (options && options.height) || this.compositor.height;
        const fps = (options && options.fps) || this.compositor.fps;
        const totalFrames = this.compositor.totalFrames;

        if (totalFrames <= 0) {
            return { success: false, error: 'No frames to export (empty timeline)' };
        }

        // V2 GPU-native export probe — if available, use zero-readback path
        if (!(options && options._skipV2) && typeof window.electronAPI.v2Probe === 'function') {
            try {
                const v2 = await window.electronAPI.v2Probe();
                if (v2 && v2.ok) {
                    console.log('[ExportPipeline] V2 GPU-native export available — using V2 path');
                    return this._runV2Export(options);
                }
                console.log(`[ExportPipeline] V2 unavailable (${v2 && v2.reason || 'unknown'}), using legacy`);
            } catch (e) {
                console.log(`[ExportPipeline] V2 probe failed: ${e.message}, using legacy`);
            }
        }

        const legacy = !!(options && options.legacy);

        this._running = true;
        this._cancelled = false;
        this.compositor._exporting = true;

        console.log(`[ExportPipeline] Starting ${legacy ? 'LEGACY' : 'OPTIMIZED'} export: ${totalFrames} frames, ${width}x${height} @ ${fps}fps`);
        const startTime = performance.now();

        try {
            // 1. Tell main process to spawn FFmpeg
            const startResult = await window.electronAPI.startWebGLExport({
                width, height, fps, totalFrames,
            });
            if (!startResult || !startResult.success) {
                throw new Error(startResult?.error || 'Failed to start FFmpeg process');
            }

            // 2. Allocate ring buffer pool for zero-copy frame transport
            this._initPool(width, height);

            // 2b. Try to enable PBO async readback (WebGL2 only)
            this._pboEnabled = false;
            if (this.compositor.gl instanceof WebGL2RenderingContext) {
                this._pboEnabled = this.compositor.initPBOs(width, height);
            }
            if (this._pboEnabled) {
                console.log(`[WebGL Export] ▶▶▶ PBO MODE: ON, PBOs=${this.compositor._pboCount}, maxInflight=${MAX_INFLIGHT_PBOS} ◀◀◀`);
            } else {
                const reason = !(this.compositor.gl instanceof WebGL2RenderingContext) ? 'not WebGL2' : 'init failed';
                console.log(`[WebGL Export] ▶▶▶ PBO MODE: OFF (reason: ${reason}) ◀◀◀`);
            }

            // 3. Pause all video playback, prepare for seeking
            this.compositor.pauseVideos();

            // 4. Run frame loop (legacy or optimized)
            if (legacy || !this._canUseOptimizedPath()) {
                await this._runLegacyFrameLoop(fps, totalFrames, startTime);
            } else {
                await this._runOptimizedFrameLoop(fps, totalFrames, startTime);
            }

            // 5. Finish: close FFmpeg stdin, mux audio
            const finishResult = await window.electronAPI.finishWebGLExport();
            if (!finishResult || !finishResult.success) {
                throw new Error(finishResult?.error || 'FFmpeg failed to produce output');
            }

            const totalElapsed = ((performance.now() - startTime) / 1000).toFixed(1);
            console.log(`[ExportPipeline] Export complete in ${totalElapsed}s: ${finishResult.outputPath}`);

            return { success: true, outputPath: finishResult.outputPath };

        } catch (err) {
            console.error('[ExportPipeline] Export failed:', err.message);
            try {
                await window.electronAPI.cancelWebGLExport();
            } catch (_) {}
            return { success: false, error: err.message };

        } finally {
            this._running = false;
            this.compositor._exporting = false;
            this.compositor._resetVideosForPreview();
            if (this._pboEnabled) {
                this.compositor.destroyPBOs();
                this._pboEnabled = false;
            }
            this._destroyPool();
        }
    }

    /**
     * Allocate ring buffer pool for zero-copy readPixels → IPC.
     * Pool size = EXPORT_BATCH_SIZE + 1 so we always have a free buffer
     * while a full batch is being flushed via IPC.
     */
    _initPool(width, height) {
        const frameBytes = width * height * 4;
        this._poolSize = Math.max(3, EXPORT_BATCH_SIZE + 1);
        this._pool = new Array(this._poolSize);
        for (let i = 0; i < this._poolSize; i++) {
            this._pool[i] = new Uint8Array(frameBytes);
        }
        this._poolIndex = 0;
        console.log(`[ExportPipeline] Ring buffer pool: ${this._poolSize} x ${(frameBytes / 1024 / 1024).toFixed(1)}MB = ${(this._poolSize * frameBytes / 1024 / 1024).toFixed(1)}MB total`);
    }

    /**
     * Get the next buffer from the ring pool and advance the index.
     * @returns {Uint8Array}
     */
    _nextPoolBuffer() {
        const buf = this._pool[this._poolIndex];
        this._poolIndex = (this._poolIndex + 1) % this._poolSize;
        return buf;
    }

    /**
     * Release pool memory.
     */
    _destroyPool() {
        this._pool = null;
        this._poolSize = 0;
        this._poolIndex = 0;
    }

    /**
     * Check if the optimized export path is available.
     * Phase 1: requires WebCodecs VideoDecoder + VideoFrameSource class.
     */
    _canUseOptimizedPath() {
        // Phase 1: WebCodecs sequential decode (no per-frame seeking/RAF)
        // Phase 2 (future): + PBO async readback + batched IPC
        return typeof VideoFrameSource !== 'undefined'
            && typeof VideoDecoder !== 'undefined';
    }

    // ========================================================================
    // LEGACY FRAME LOOP (current working path)
    // ========================================================================

    /**
     * Legacy export: per-frame HTMLVideoElement seeking + RAF yield + sync readPixels + per-frame IPC.
     */
    async _runLegacyFrameLoop(fps, totalFrames, startTime) {
        let usePBO = this._pboEnabled;
        console.log(`[ExportPipeline] Legacy loop: batchSize=${EXPORT_BATCH_SIZE}, pbo=${usePBO}`);
        let lastProgressTime = 0;
        const batch = [];

        // PBO pipeline FIFO — drain when MAX_INFLIGHT_PBOS reached
        const pending = [];
        let consecutiveTimeouts = 0;

        for (let frame = 0; frame < totalFrames; frame++) {
            if (this._cancelled) throw new Error('Export cancelled');

            // Seek all active videos to this frame
            const activeScenes = this.compositor.sceneGraph.getActiveScenesAtFrame(frame);
            let didSeek = false;
            for (const { scene } of activeScenes) {
                if (scene.isMGScene || scene.mediaType === 'motion-graphic') continue;
                const localFrame = frame - scene._startFrame;
                const mediaOffsetFrames = Math.round((scene.mediaOffset || 0) * fps);
                await this.compositor.seekVideoToFrame(scene.index, localFrame + mediaOffsetFrames);
                didSeek = true;
            }

            // Yield to browser so video frames are decoded for texImage2D
            if (didSeek) {
                await new Promise(resolve => requestAnimationFrame(resolve));
            }

            // Render the frame
            this.compositor.renderFrame(frame);

            if (usePBO) {
                // Flow control: drain oldest when in-flight count hits limit
                while (pending.length >= MAX_INFLIGHT_PBOS) {
                    const old = pending.shift();
                    const fenceOk = await this.compositor.awaitFence(old.sync);

                    if (!fenceOk) {
                        consecutiveTimeouts++;
                        console.warn(`[ExportPipeline] PBO fence timeout #${consecutiveTimeouts} at frame ${old.frame}`);

                        if (consecutiveTimeouts >= 2) {
                            // 2 consecutive timeouts — disable PBO, drain all pending via sync
                            console.warn(`[ExportPipeline] ${consecutiveTimeouts} consecutive timeouts -> disabling PBO, falling back to sync`);
                            pending.unshift(old);
                            for (const p of pending) {
                                this.compositor.renderFrame(p.frame);
                                const target = this._nextPoolBuffer();
                                this.compositor.readPixelsInto(target);
                                await this._addToBatch(batch, p.frame, target.buffer);
                                if (p.sync) try { this.compositor.gl.deleteSync(p.sync); } catch (_) {}
                            }
                            pending.length = 0;
                            usePBO = false;
                            this._pboEnabled = false;
                            this.compositor.destroyPBOs();
                            break;
                        }

                        // First timeout — proceed with stall (getBufferSubData will block)
                        console.warn(`[ExportPipeline] First timeout, proceeding with stall readback for frame ${old.frame}`);
                    } else {
                        consecutiveTimeouts = 0;
                    }

                    const target = this._nextPoolBuffer();
                    this.compositor.readBackPBO(old.pboIndex, target);

                    if (old.frame < 3) {
                        console.log(`[ExportPipeline] PBO readback frame ${old.frame}: PBO[${old.pboIndex}] -> pool slot ${(this._poolIndex + this._poolSize - 1) % this._poolSize}`);
                    }

                    await this._addToBatch(batch, old.frame, target.buffer);
                }

                // After flow control: issue new PBO read (or skip if PBO was disabled above)
                if (usePBO) {
                    const pboIndex = this.compositor.readPixelsIntoPBO();
                    const sync = this.compositor.createFence();
                    pending.push({ frame, pboIndex, sync });
                } else {
                    // PBO was just disabled by timeout — use sync for this frame
                    const target = this._nextPoolBuffer();
                    this.compositor.readPixelsInto(target);
                    await this._addToBatch(batch, frame, target.buffer);
                }
            } else {
                // SYNC PATH: direct readPixels into pool buffer
                const target = this._nextPoolBuffer();
                this.compositor.readPixelsInto(target);

                if (frame < 3) {
                    console.log(`[ExportPipeline] Frame ${frame}: pool slot ${(this._poolIndex + this._poolSize - 1) % this._poolSize}, ArrayBuffer @${target.byteOffset}`);
                }

                await this._addToBatch(batch, frame, target.buffer);
            }

            // Progress reporting
            this._reportProgress(frame, totalFrames, startTime, lastProgressTime, (t) => { lastProgressTime = t; });
        }

        // PBO DRAIN: read back all remaining pending frames in order
        while (pending.length > 0) {
            const old = pending.shift();
            const fenceOk = await this.compositor.awaitFence(old.sync);
            if (!fenceOk) {
                // Fence timeout during drain — re-render remaining via sync
                console.warn(`[ExportPipeline] PBO fence timeout during drain at frame ${old.frame} -> falling back to sync`);
                this.compositor.renderFrame(old.frame);
                const target = this._nextPoolBuffer();
                this.compositor.readPixelsInto(target);
                await this._addToBatch(batch, old.frame, target.buffer);
                // Clean up remaining fences
                for (const p of pending) {
                    if (p.sync) try { this.compositor.gl.deleteSync(p.sync); } catch (_) {}
                    this.compositor.renderFrame(p.frame);
                    const t = this._nextPoolBuffer();
                    this.compositor.readPixelsInto(t);
                    await this._addToBatch(batch, p.frame, t.buffer);
                }
                pending.length = 0;
                this.compositor.destroyPBOs();
                break;
            }
            const target = this._nextPoolBuffer();
            this.compositor.readBackPBO(old.pboIndex, target);
            console.log(`[ExportPipeline] PBO drain: frame ${old.frame} from PBO[${old.pboIndex}]`);
            await this._addToBatch(batch, old.frame, target.buffer);
        }

        // Flush final partial batch
        await this._flushBatch(batch);
    }

    // ========================================================================
    // OPTIMIZED FRAME LOOP (WebCodecs + PBO + batch IPC)
    // ========================================================================

    /**
     * Optimized export: WebCodecs sequential decode replaces per-frame HTMLVideoElement seeking.
     * Eliminates the seek + seeked-event + requestAnimationFrame yield per frame.
     * Falls back per-scene to legacy seeking if WebCodecs init fails (non-MP4, unsupported codec).
     *
     * Guarantees:
     *  - Renders the exact same frameIndex sequence as legacy (0..totalFrames-1)
     *  - compositor._exportFrameSources cleared in finally{} even on cancel/error
     *  - All VideoFrames closed on exit to prevent GPU memory leaks
     *  - Legacy path still available via options.legacy=true for hash comparison
     */
    async _runOptimizedFrameLoop(fps, totalFrames, startTime) {
        const vfs = new VideoFrameSource();
        const webcodecScenes = new Set();  // sceneIndex → uses WebCodecs
        const legacyScenes = new Set();    // sceneIndex → falls back to HTMLVideoElement seek

        // 1. Init WebCodecs decoders for all video scenes
        const allScenes = this.compositor.sceneGraph.scenes;
        const initPromises = [];

        for (const scene of allScenes) {
            if (scene.isMGScene || scene.mediaType === 'motion-graphic') continue;
            if (scene.mediaType === 'image') continue;
            const idx = scene.index;
            const url = this.compositor._mediaUrls[idx];
            if (!url) {
                legacyScenes.add(idx);
                console.log(`[ExportPipeline] Fallback to LEGACY for scene ${idx} (no media URL)`);
                continue;
            }

            const ext = (scene.mediaExtension || '.mp4').toLowerCase();
            if (ext !== '.mp4') {
                legacyScenes.add(idx);
                console.log(`[ExportPipeline] Fallback to LEGACY for scene ${idx} (non-MP4: ${ext})`);
                continue;
            }

            initPromises.push(
                vfs.init(idx, url, fps).then(ok => {
                    if (ok) {
                        webcodecScenes.add(idx);
                        const state = vfs._decoders.get(idx);
                        const codec = state && state.codecConfig ? state.codecConfig.codec : 'unknown';
                        console.log(`[ExportPipeline] Using OPTIMIZED WebCodecs for scene ${idx} (${codec})`);
                    } else {
                        legacyScenes.add(idx);
                        console.log(`[ExportPipeline] Fallback to LEGACY for scene ${idx} (WebCodecs init failed)`);
                    }
                })
            );
        }

        await Promise.all(initPromises);
        console.log(`[ExportPipeline] Optimized: ${webcodecScenes.size} WebCodecs, ${legacyScenes.size} legacy scenes`);

        // If no scenes could use WebCodecs, fall back entirely to legacy
        if (webcodecScenes.size === 0) {
            console.warn('[ExportPipeline] No WebCodecs decoders initialized, falling back to legacy');
            vfs.closeAll();
            return this._runLegacyFrameLoop(fps, totalFrames, startTime);
        }

        // 2. Frame loop — same frame indices as legacy (0..totalFrames-1)
        let usePBO = this._pboEnabled;
        console.log(`[ExportPipeline] Optimized loop: batchSize=${EXPORT_BATCH_SIZE}, pbo=${usePBO}`);
        let lastProgressTime = 0;
        const exportFrameSources = new Map();
        this.compositor._exportFrameSources = exportFrameSources;
        const batch = [];

        // PBO pipeline FIFO — drain when MAX_INFLIGHT_PBOS reached
        const pending = [];
        let consecutiveTimeouts = 0;

        try {
            for (let frame = 0; frame < totalFrames; frame++) {
                if (this._cancelled) throw new Error('Export cancelled');

                const activeScenes = this.compositor.sceneGraph.getActiveScenesAtFrame(frame);
                exportFrameSources.clear();
                let didLegacySeek = false;

                for (const { scene } of activeScenes) {
                    if (scene.isMGScene || scene.mediaType === 'motion-graphic') continue;
                    if (scene.mediaType === 'image') continue;
                    const idx = scene.index;
                    const localFrame = frame - scene._startFrame;
                    const mediaOffsetFrames = Math.round((scene.mediaOffset || 0) * fps);
                    const timeSec = (localFrame + mediaOffsetFrames) / fps;

                    if (webcodecScenes.has(idx)) {
                        // WebCodecs: sequential decode — no seek, no RAF yield needed
                        const videoFrame = await vfs.getFrameAtTime(idx, timeSec);
                        if (videoFrame) {
                            exportFrameSources.set(idx, videoFrame);
                        } else {
                            // End of stream or closed frame — fall back to legacy seek for this frame
                            await this.compositor.seekVideoToFrame(idx, localFrame + mediaOffsetFrames);
                            didLegacySeek = true;
                        }
                    } else if (legacyScenes.has(idx)) {
                        // Legacy: HTMLVideoElement seek (same as _runLegacyFrameLoop)
                        await this.compositor.seekVideoToFrame(idx, localFrame + mediaOffsetFrames);
                        didLegacySeek = true;
                    }
                }

                // Only yield for RAF if we did a legacy seek (WebCodecs frames are ready)
                if (didLegacySeek) {
                    await new Promise(resolve => requestAnimationFrame(resolve));
                }

                // Render — _getSceneTexture checks _exportFrameSources for WebCodecs scenes
                this.compositor.renderFrame(frame);

                // Close VideoFrames immediately after render — texImage2D already copied
                // pixels to GPU, so the decoded frame backing memory can be released now.
                // Also null out VideoFrameSource's currentFrame ref so getFrameAtTime
                // won't return a closed frame on end-of-stream reuse (returns null instead).
                for (const [idx, vf] of exportFrameSources.entries()) {
                    try { vf.close(); } catch (_) {}
                    const decState = vfs._decoders.get(idx);
                    if (decState && decState.currentFrame === vf) {
                        decState.currentFrame = null;
                    }
                }

                if (usePBO) {
                    // Flow control: drain oldest when in-flight count hits limit
                    while (pending.length >= MAX_INFLIGHT_PBOS) {
                        const old = pending.shift();
                        const fenceOk = await this.compositor.awaitFence(old.sync);

                        if (!fenceOk) {
                            consecutiveTimeouts++;
                            console.warn(`[ExportPipeline] PBO fence timeout #${consecutiveTimeouts} at frame ${old.frame}`);

                            if (consecutiveTimeouts >= 2) {
                                // 2 consecutive timeouts — disable PBO + WebCodecs, drain pending via full legacy
                                console.warn(`[ExportPipeline] ${consecutiveTimeouts} consecutive timeouts -> disabling PBO + WebCodecs, falling back to full legacy`);

                                // Kill WebCodecs decoders (prevents "codec reclaimed" cascade)
                                vfs.closeAll();
                                for (const idx of webcodecScenes) legacyScenes.add(idx);
                                webcodecScenes.clear();
                                exportFrameSources.clear();
                                this.compositor._exportFrameSources = null;

                                // Drain pending frames via sync re-render
                                pending.unshift(old);
                                for (const p of pending) {
                                    if (p.sync) try { this.compositor.gl.deleteSync(p.sync); } catch (_) {}
                                    const activeAtFrame = this.compositor.sceneGraph.getActiveScenesAtFrame(p.frame);
                                    for (const { scene } of activeAtFrame) {
                                        if (scene.isMGScene || scene.mediaType === 'motion-graphic' || scene.mediaType === 'image') continue;
                                        const lf = p.frame - scene._startFrame;
                                        const mof = Math.round((scene.mediaOffset || 0) * fps);
                                        await this.compositor.seekVideoToFrame(scene.index, lf + mof);
                                    }
                                    await new Promise(resolve => requestAnimationFrame(resolve));
                                    this.compositor.renderFrame(p.frame);
                                    const target = this._nextPoolBuffer();
                                    this.compositor.readPixelsInto(target);
                                    await this._addToBatch(batch, p.frame, target.buffer);
                                }
                                pending.length = 0;
                                usePBO = false;
                                this._pboEnabled = false;
                                this.compositor.destroyPBOs();
                                break;
                            }

                            // First timeout — proceed with stall (getBufferSubData will block)
                            console.warn(`[ExportPipeline] First timeout, proceeding with stall readback for frame ${old.frame}`);
                        } else {
                            consecutiveTimeouts = 0;
                        }

                        const target = this._nextPoolBuffer();
                        this.compositor.readBackPBO(old.pboIndex, target);

                        if (old.frame < 3) {
                            console.log(`[ExportPipeline] PBO readback frame ${old.frame}: PBO[${old.pboIndex}] -> pool slot ${(this._poolIndex + this._poolSize - 1) % this._poolSize}`);
                        }

                        await this._addToBatch(batch, old.frame, target.buffer);
                    }

                    // Issue new PBO read (or sync fallback if PBO was just disabled)
                    if (usePBO) {
                        const pboIndex = this.compositor.readPixelsIntoPBO();
                        const sync = this.compositor.createFence();
                        pending.push({ frame, pboIndex, sync });
                    } else {
                        // PBO was just disabled — use legacy seek + sync for this frame
                        const activeAtFrame = this.compositor.sceneGraph.getActiveScenesAtFrame(frame);
                        for (const { scene } of activeAtFrame) {
                            if (scene.isMGScene || scene.mediaType === 'motion-graphic' || scene.mediaType === 'image') continue;
                            const lf = frame - scene._startFrame;
                            const mof = Math.round((scene.mediaOffset || 0) * fps);
                            await this.compositor.seekVideoToFrame(scene.index, lf + mof);
                        }
                        await new Promise(resolve => requestAnimationFrame(resolve));
                        this.compositor.renderFrame(frame);
                        const target = this._nextPoolBuffer();
                        this.compositor.readPixelsInto(target);
                        await this._addToBatch(batch, frame, target.buffer);
                    }
                } else {
                    // SYNC PATH: direct readPixels into pool buffer
                    const target = this._nextPoolBuffer();
                    this.compositor.readPixelsInto(target);

                    if (frame < 3) {
                        console.log(`[ExportPipeline] Frame ${frame}: pool slot ${(this._poolIndex + this._poolSize - 1) % this._poolSize}, ArrayBuffer @${target.byteOffset}`);
                    }

                    await this._addToBatch(batch, frame, target.buffer);
                }

                this._reportProgress(frame, totalFrames, startTime, lastProgressTime, (t) => { lastProgressTime = t; });
            }

            // PBO DRAIN: read back all remaining pending frames in order
            while (pending.length > 0) {
                const old = pending.shift();
                const fenceOk = await this.compositor.awaitFence(old.sync);
                if (!fenceOk) {
                    // Fence timeout during drain — kill WebCodecs, re-render remaining via legacy sync
                    console.warn(`[ExportPipeline] PBO fence timeout during drain at frame ${old.frame} -> falling back to legacy sync`);
                    vfs.closeAll();
                    exportFrameSources.clear();
                    this.compositor._exportFrameSources = null;

                    // Re-render timed-out frame + all remaining via legacy seek
                    const allRemaining = [old, ...pending];
                    pending.length = 0;
                    for (const p of allRemaining) {
                        if (p.sync) try { this.compositor.gl.deleteSync(p.sync); } catch (_) {}
                        const activeAtFrame = this.compositor.sceneGraph.getActiveScenesAtFrame(p.frame);
                        for (const { scene } of activeAtFrame) {
                            if (scene.isMGScene || scene.mediaType === 'motion-graphic' || scene.mediaType === 'image') continue;
                            const lf = p.frame - scene._startFrame;
                            const mof = Math.round((scene.mediaOffset || 0) * fps);
                            await this.compositor.seekVideoToFrame(scene.index, lf + mof);
                        }
                        await new Promise(resolve => requestAnimationFrame(resolve));
                        this.compositor.renderFrame(p.frame);
                        const t = this._nextPoolBuffer();
                        this.compositor.readPixelsInto(t);
                        await this._addToBatch(batch, p.frame, t.buffer);
                    }
                    this.compositor.destroyPBOs();
                    break;
                }
                const target = this._nextPoolBuffer();
                this.compositor.readBackPBO(old.pboIndex, target);
                console.log(`[ExportPipeline] PBO drain: frame ${old.frame} from PBO[${old.pboIndex}]`);
                await this._addToBatch(batch, old.frame, target.buffer);
            }

            // Flush final partial batch
            await this._flushBatch(batch);
        } finally {
            // Always clean up — even on cancel/error
            this.compositor._exportFrameSources = null;
            vfs.closeAll();
        }
    }

    // ========================================================================
    // VALIDATION
    // ========================================================================

    /**
     * Validate frame hashes: render specific frames and log their hashes.
     * Use this to compare legacy vs optimized export output.
     *
     * @param {number[]} testFrames - Frame indices to validate (e.g. [0, 100, 500, lastFrame-1])
     * @returns {Promise<Array<{frame: number, hash: string}>>}
     */
    async validate(testFrames) {
        if (!this.compositor || !this.compositor.isInitialized || !this.compositor.sceneGraph) {
            console.error('[Validation] Compositor not ready');
            return [];
        }

        const totalFrames = this.compositor.totalFrames;
        const fps = this.compositor.fps;
        const results = [];

        // Save exporting state and restore after
        const wasExporting = this.compositor._exporting;
        this.compositor._exporting = true;
        this.compositor.pauseVideos();

        try {
            for (const frame of testFrames) {
                if (frame < 0 || frame >= totalFrames) {
                    console.warn(`[Validation] Frame ${frame} out of range (0-${totalFrames - 1}), skipping`);
                    continue;
                }

                // Seek all active videos to this frame
                const activeScenes = this.compositor.sceneGraph.getActiveScenesAtFrame(frame);
                for (const { scene } of activeScenes) {
                    if (scene.isMGScene || scene.mediaType === 'motion-graphic') continue;
                    const localFrame = frame - scene._startFrame;
                    const mediaOffsetFrames = Math.round((scene.mediaOffset || 0) * fps);
                    await this.compositor.seekVideoToFrame(scene.index, localFrame + mediaOffsetFrames);
                }
                // Yield for video frame decode
                await new Promise(resolve => requestAnimationFrame(resolve));

                // Render and hash
                this.compositor.renderFrame(frame);
                const hash = this.compositor.computeFrameHash();
                results.push({ frame, hash });
                console.log(`[Validation] Frame ${frame}: hash=${hash}`);
            }
        } finally {
            this.compositor._exporting = wasExporting;
            this.compositor._resetVideosForPreview();
        }

        return results;
    }

    // ========================================================================
    // HELPERS
    // ========================================================================

    /**
     * Throttled progress reporting.
     */
    _reportProgress(frame, totalFrames, startTime, lastProgressTime, setLastTime) {
        const now = performance.now();
        if (now - lastProgressTime > 100 || frame === totalFrames - 1) {
            setLastTime(now);
            const percent = Math.round(((frame + 1) / totalFrames) * 100);
            const elapsed = (now - startTime) / 1000;
            const currentFps = elapsed > 0 ? ((frame + 1) / elapsed).toFixed(1) : '0';

            if (this._progressCallback) {
                this._progressCallback({
                    percent,
                    currentFrame: frame + 1,
                    totalFrames,
                    fps: currentFps,
                    elapsed: elapsed.toFixed(1),
                });
            }
        }
    }

    /**
     * Add a rendered frame to the batch. Flushes when batch is full.
     * Zero-copy: the ArrayBuffer comes from the ring pool and is NOT copied here.
     * Safe because pool has BATCH_SIZE+1 slots, so flushed buffers are never
     * reused until the IPC call completes.
     *
     * @param {Array} batch - Mutable batch array
     * @param {number} frameIndex
     * @param {ArrayBuffer} arrayBuffer - Pool buffer's .buffer (already contains pixel data)
     */
    async _addToBatch(batch, frameIndex, arrayBuffer) {
        batch.push({ frameIndex, buffer: arrayBuffer });

        if (batch.length >= EXPORT_BATCH_SIZE) {
            await this._flushBatch(batch);
        }
    }

    /**
     * Flush all frames in the batch to the main process via IPC.
     * Uses batched API if available, falls back to per-frame sends.
     * Clears the batch array after sending.
     */
    async _flushBatch(batch) {
        if (batch.length === 0) return;

        if (typeof window.electronAPI.sendExportFramesBatch === 'function') {
            const result = await window.electronAPI.sendExportFramesBatch({ frames: batch });
            if (!result || !result.success) {
                throw new Error('Failed to write frame batch to FFmpeg');
            }
        } else {
            // Fallback: send one at a time
            for (const entry of batch) {
                const result = await window.electronAPI.sendExportFrame(entry.buffer);
                if (!result || !result.success) {
                    throw new Error('Failed to write frame to FFmpeg');
                }
            }
        }

        batch.length = 0;
    }

    /**
     * V2 GPU-native export — readPixels + V2 FFmpeg encoder.
     *
     * NOTE: Shared D3D11 texture redirect does NOT work — renderer WebGL
     * uses a GPU-thread EGL context that is inaccessible from main/renderer JS.
     * eglMakeCurrent on either thread doesn't affect the GPU thread's context.
     * (Proven by test-v2-compositor.js Phase B + Phase C)
     *
     * Current V2 path uses readPixels (same as legacy) but routes pixel data
     * through the V2 encoder IPC (v2InitEncoder → v2EncodeFrame → v2FlushEncoder).
     * V2 encoder writes raw RGBA to FFmpeg stdin with NVENC when available.
     *
     * TODO: Phase 3 NVENC — encode from D3D11 texture for true zero-readback.
     *       Requires either ANGLE D3D11 device sharing or WebCodecs VideoEncoder.
     */
    async _runV2Export(options) {
        const width = (options && options.width) || this.compositor.width;
        const height = (options && options.height) || this.compositor.height;
        const fps = (options && options.fps) || this.compositor.fps;
        const totalFrames = this.compositor.totalFrames;

        this._running = true;
        this._cancelled = false;
        this.compositor._exporting = true;

        console.log(`[V2 Export] Starting: ${totalFrames} frames, ${width}x${height} @ ${fps}fps (readPixels path)`);
        const startTime = performance.now();

        try {
            // 1. Spawn FFmpeg with RGBA rawvideo input
            const encoder = await window.electronAPI.v2InitEncoder({
                width, height, fps, totalFrames,
                pixelFormat: 'rgba',
            });
            if (!encoder || !encoder.ok) {
                console.warn(`[V2 Export] initEncoder failed: ${encoder && encoder.reason}, falling back to legacy`);
                this._running = false;
                this.compositor._exporting = false;
                return this.start(Object.assign({}, options, { _skipV2: true }));
            }
            console.log(`[V2 Export] FFmpeg spawned → ${encoder.videoFile}`);

            // 2. Pause videos, prepare for seeking
            this.compositor.pauseVideos();

            // 3. Allocate readPixels buffer
            const frameBytes = width * height * 4;
            const pixelBuf = new Uint8Array(frameBytes);

            // 4. Frame loop
            let lastProgressTime = 0;

            for (let frame = 0; frame < totalFrames; frame++) {
                if (this._cancelled) throw new Error('Export cancelled');

                // Seek active videos to this frame
                const activeScenes = this.compositor.sceneGraph.getActiveScenesAtFrame(frame);
                let didSeek = false;
                for (const { scene } of activeScenes) {
                    if (scene.isMGScene || scene.mediaType === 'motion-graphic') continue;
                    const localFrame = frame - scene._startFrame;
                    const mediaOffsetFrames = Math.round((scene.mediaOffset || 0) * fps);
                    await this.compositor.seekVideoToFrame(scene.index, localFrame + mediaOffsetFrames);
                    didSeek = true;
                }

                // Yield for video frame decode
                if (didSeek) {
                    await new Promise(resolve => requestAnimationFrame(resolve));
                }

                // Render the frame
                this.compositor.renderFrame(frame);

                // readPixels → RGBA buffer
                this.compositor.readPixelsInto(pixelBuf);

                // Send to main process → FFmpeg stdin
                const enc = await window.electronAPI.v2EncodeFrame({
                    frameBuffer: pixelBuf.buffer,
                    frameIndex: frame,
                });

                if (!enc || !enc.ok) {
                    throw new Error(`v2EncodeFrame failed at frame ${frame}: ${enc && enc.error}`);
                }

                // Progress
                this._reportProgress(frame, totalFrames, startTime, lastProgressTime, (t) => { lastProgressTime = t; });
            }

            // 5. Flush encoder — close FFmpeg, mux audio
            const flushResult = await window.electronAPI.v2FlushEncoder();
            if (!flushResult || !flushResult.ok) {
                throw new Error(flushResult?.error || 'FFmpeg failed to produce output');
            }

            const totalElapsed = ((performance.now() - startTime) / 1000).toFixed(1);
            const avgFps = (totalFrames / ((performance.now() - startTime) / 1000)).toFixed(1);
            console.log(`[V2 Export] Complete in ${totalElapsed}s (${avgFps} fps): ${flushResult.outputPath}`);

            return { success: true, outputPath: flushResult.outputPath };

        } catch (err) {
            console.error('[V2 Export] Failed:', err.message);
            try { await window.electronAPI.v2FlushEncoder(); } catch (_) {}
            return { success: false, error: err.message };

        } finally {
            this._running = false;
            this.compositor._exporting = false;
            this.compositor._resetVideosForPreview();
        }
    }

    /**
     * Cancel an in-progress export.
     */
    cancel() {
        this._cancelled = true;
    }
}

window.ExportPipeline = ExportPipeline;
