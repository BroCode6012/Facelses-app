/**
 * ExportPipeline.js — Offline render loop for WebGL2 compositor export
 *
 * Drives the compositor frame-by-frame:
 *   renderFrame(f) -> readPixels() -> IPC to main process -> FFmpeg NVENC encode
 *
 * The main process spawns FFmpeg with raw RGBA pipe input and handles encoding.
 * Audio is muxed separately after all video frames are written.
 */

class ExportPipeline {
    /**
     * @param {Compositor} compositor - The initialized compositor engine
     */
    constructor(compositor) {
        this.compositor = compositor;
        this._cancelled = false;
        this._progressCallback = null;
        this._running = false;
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

        this._running = true;
        this._cancelled = false;
        this.compositor._exporting = true;

        console.log(`[ExportPipeline] Starting export: ${totalFrames} frames, ${width}x${height} @ ${fps}fps`);
        const startTime = performance.now();

        try {
            // 1. Tell main process to spawn FFmpeg
            const startResult = await window.electronAPI.startWebGLExport({
                width, height, fps, totalFrames,
            });
            if (!startResult || !startResult.success) {
                throw new Error(startResult?.error || 'Failed to start FFmpeg process');
            }

            // 2. Pause all video playback, prepare for seeking
            this.compositor.pauseVideos();

            // 3. Frame loop
            let lastProgressTime = 0;
            for (let frame = 0; frame < totalFrames; frame++) {
                if (this._cancelled) {
                    throw new Error('Export cancelled');
                }

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

                // CRITICAL: Yield to browser rendering pipeline so video frames
                // are actually decoded and available for texImage2D upload.
                // Without this, the browser never paints and video textures stay stale.
                if (didSeek) {
                    await new Promise(resolve => requestAnimationFrame(resolve));
                }

                // Render the frame
                this.compositor.renderFrame(frame);

                // Read pixels (flipped to top-down)
                const pixels = this.compositor.readPixels();

                // Send to main process via IPC
                // Transfer the underlying ArrayBuffer for efficiency
                const result = await window.electronAPI.sendExportFrame(pixels.buffer);
                if (!result || !result.success) {
                    throw new Error('Failed to write frame to FFmpeg');
                }

                // Progress reporting (throttled to every 100ms)
                const now = performance.now();
                if (now - lastProgressTime > 100 || frame === totalFrames - 1) {
                    lastProgressTime = now;
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

            // 4. Finish: close FFmpeg stdin, mux audio
            const finishResult = await window.electronAPI.finishWebGLExport();
            if (!finishResult || !finishResult.success) {
                throw new Error(finishResult?.error || 'FFmpeg failed to produce output');
            }

            const totalElapsed = ((performance.now() - startTime) / 1000).toFixed(1);
            console.log(`[ExportPipeline] Export complete in ${totalElapsed}s: ${finishResult.outputPath}`);

            return { success: true, outputPath: finishResult.outputPath };

        } catch (err) {
            console.error('[ExportPipeline] Export failed:', err.message);
            // Try to cancel FFmpeg process
            try {
                await window.electronAPI.cancelWebGLExport();
            } catch (_) {}
            return { success: false, error: err.message };

        } finally {
            this._running = false;
            this.compositor._exporting = false;
            // Reset all video elements to beginning so preview isn't stuck at last export frame
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
