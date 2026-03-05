'use strict';

/**
 * mg-png-renderer.js — Pre-render MGs as RGBA PNG frame sequences for native export.
 *
 * Canvas path (14 types): renders at 2x supersample → downscale → PNG files
 * Remotion path (3 types): renderMedia({imageSequence:true}) → rename to pattern
 *
 * Each MG gets a deterministic hash-based cache dir. If already rendered (manifest.complete),
 * skipped. Outputs: { layers: [{ seqDir, seqPattern, seqFrameCount, ... }] }
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
    canRenderWithCanvas,
    CANVAS_RENDERERS,
    REMOTION_ONLY_TYPES,
    getCanvasModule,
    computeAnimationState,
} = require('./canvas-mg-renderer');
const { getStyle, MG_BACKGROUNDS } = require('./mg-style-utils');

const SUPERSAMPLE = 2;
const S = SUPERSAMPLE;

// Tile sizes for overlay vs fullscreen MGs
const OVERLAY_TILE = { w: 1024, h: 256 };   // lower thirds, callouts, etc.
const FULLSCREEN_TILE = { w: 1920, h: 1080 };

const CANVAS_CONCURRENCY = 3;
const REMOTION_CONCURRENCY = 2;

function log(msg) { console.log(`[MGPngRenderer] ${msg}`); }

/**
 * Compute deterministic hash for MG job — same inputs = same hash = cached.
 */
function computeJobHash(mg, fps, tileW, tileH, isFullScreen) {
    const data = JSON.stringify({
        type: mg.type,
        text: mg.text || '',
        subtext: mg.subtext || '',
        style: mg.style || 'clean',
        position: mg.position || 'center',
        duration: mg.duration || 3,
        animationSpeed: mg.animationSpeed || 1.0,
        data: mg.data || null,
        fps, tileW, tileH, isFullScreen,
    });
    return crypto.createHash('sha1').update(data).digest('hex').slice(0, 16);
}

/**
 * Render a single canvas-compatible MG to PNG frame sequence.
 */
async function renderCanvasMG(mg, outDir, fps, scriptContext, tileW, tileH, isFullScreen) {
    const { createCanvas } = getCanvasModule();
    const PW = tileW * S;
    const PH = tileH * S;
    const canvas = createCanvas(PW, PH);
    const ctx = canvas.getContext('2d');

    mg._animationSpeed = mg.animationSpeed || scriptContext.mgAnimationSpeed || 1.0;
    const s = getStyle(mg, scriptContext);
    const totalFrames = Math.max(1, Math.round((mg.duration || 3) * fps));
    const renderFn = CANVAS_RENDERERS[mg.type];

    if (!renderFn) {
        throw new Error(`No canvas renderer for MG type: ${mg.type}`);
    }

    // Helper to draw fullscreen BG (replicated from canvas-mg-renderer since it's not exported)
    function drawFullscreenBG(ctx, styleName) {
        const bg = MG_BACKGROUNDS[styleName] || MG_BACKGROUNDS.clean || ['#0a0a2e', '#000000'];
        const grad = ctx.createRadialGradient(tileW / 2, tileH / 2, 0, tileW / 2, tileH / 2, tileW * 0.7);
        grad.addColorStop(0, bg[0]);
        grad.addColorStop(1, bg[1]);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, tileW, tileH);
    }

    for (let frame = 0; frame < totalFrames; frame++) {
        ctx.clearRect(0, 0, PW, PH);
        ctx.save();
        ctx.scale(S, S);

        // Fullscreen MGs get opaque bg + 1.5x scale (except focusWord/kineticText)
        const transparentFullscreen = isFullScreen && (mg.type === 'focusWord' || mg.type === 'kineticText');
        if (isFullScreen && !transparentFullscreen) {
            drawFullscreenBG(ctx, mg.style || 'clean');
            ctx.save();
            ctx.translate(tileW / 2, tileH / 2);
            ctx.scale(1.5, 1.5);
            ctx.translate(-tileW / 2, -tileH / 2);
        }

        const anim = computeAnimationState(frame, fps, mg);
        renderFn(ctx, frame, fps, mg, s, anim, isFullScreen);

        if (isFullScreen && !transparentFullscreen) ctx.restore();
        ctx.restore();

        // Encode to PNG (with downscale if supersampled)
        let pngBuf;
        if (S > 1) {
            // Downscale: render to target-size canvas then encode
            const outCanvas = createCanvas(tileW, tileH);
            const outCtx = outCanvas.getContext('2d');
            outCtx.drawImage(canvas, 0, 0, PW, PH, 0, 0, tileW, tileH);
            pngBuf = outCanvas.toBuffer('image/png');
        } else {
            pngBuf = canvas.toBuffer('image/png');
        }

        const frameName = `frame_${String(frame).padStart(6, '0')}.png`;
        fs.writeFileSync(path.join(outDir, frameName), pngBuf);
    }

    return totalFrames;
}

/**
 * Render a single Remotion-only MG to PNG frame sequence.
 */
async function renderRemotionMG(mg, outDir, fps, scriptContext, tileW, tileH, isFullScreen) {
    let bundleFn, renderMediaFn, selectCompositionFn;
    try {
        const bundler = require('@remotion/bundler');
        const renderer = require('@remotion/renderer');
        bundleFn = bundler.bundle;
        renderMediaFn = renderer.renderMedia;
        selectCompositionFn = renderer.selectComposition;
    } catch (e) {
        throw new Error(`Remotion not available: ${e.message}`);
    }

    const totalFrames = Math.max(1, Math.round((mg.duration || 3) * fps));
    const rootFile = path.join(__dirname, 'remotion', 'Root.jsx');
    const publicDir = path.join(__dirname, '..', 'public');

    const binOpts = {};
    if (fs.existsSync('C:\\ffmg\\bin\\ffmpeg.exe')) {
        binOpts.ffmpegExecutable = 'C:\\ffmg\\bin\\ffmpeg.exe';
    }

    const bundleLocation = await bundleFn({ entryPoint: rootFile, publicDir });

    const composition = await selectCompositionFn({
        serveUrl: bundleLocation, id: 'MGPreRender',
        inputProps: { mg, scriptContext, duration: mg.duration || 3, isFullScreen },
        ...binOpts,
    });

    // Render as image sequence (PNGs)
    await renderMediaFn({
        composition,
        serveUrl: bundleLocation,
        imageSequence: true,
        imageFormat: 'png',
        outputLocation: outDir,
        chromiumOptions: { gl: 'angle' },
        ...binOpts,
    });

    // Remotion outputs element-0.png, element-1.png, etc.
    // Rename to frame_000000.png pattern
    for (let i = 0; i < totalFrames; i++) {
        const remotionName = path.join(outDir, `element-${i}.png`);
        const targetName = path.join(outDir, `frame_${String(i).padStart(6, '0')}.png`);
        if (fs.existsSync(remotionName)) {
            fs.renameSync(remotionName, targetName);
        }
    }

    return totalFrames;
}

/**
 * Get tile dimensions for an MG based on type and whether it's fullscreen.
 */
function getTileDimensions(mg, isFullScreen) {
    if (isFullScreen) return { w: FULLSCREEN_TILE.w, h: FULLSCREEN_TILE.h };

    // Overlay MGs: use small tiles based on type
    switch (mg.type) {
        case 'lowerThird':
        case 'subscribeCTA':
            return { w: 1024, h: 256 };
        case 'headline':
        case 'callout':
        case 'bulletList':
        case 'rankingList':
            return { w: 1024, h: 512 };
        case 'barChart':
        case 'donutChart':
        case 'comparisonCard':
        case 'timeline':
            return { w: 1280, h: 720 };
        case 'focusWord':
        case 'kineticText':
            return { w: 1920, h: 1080 };
        case 'statCounter':
        case 'progressBar':
            return { w: 800, h: 300 };
        default:
            return { w: 1024, h: 512 };
    }
}

/**
 * Run render jobs with concurrency limit.
 */
async function runWithConcurrency(jobs, limit) {
    const results = [];
    let idx = 0;

    async function next() {
        const myIdx = idx++;
        if (myIdx >= jobs.length) return;
        results[myIdx] = await jobs[myIdx]();
        await next();
    }

    const workers = [];
    for (let i = 0; i < Math.min(limit, jobs.length); i++) {
        workers.push(next());
    }
    await Promise.all(workers);
    return results;
}

/**
 * Main entry point: pre-render all MGs to PNG sequences with caching.
 *
 * @param {object} opts - { motionGraphics, mgScenes, scenes, scriptContext, fps, width, height }
 * @param {string} cacheDir - base cache directory (e.g. temp/mg-cache)
 * @param {function} progressCb - (percent, message) => void
 * @returns {{ layers: Array<{ seqDir, seqPattern, seqFrameCount, seqLocalStart, tileW, tileH, isFullScreen, mgIndex, startFrame, endFrame, trackNum }> }}
 */
async function renderMGsToPNG(opts, cacheDir, progressCb = () => {}) {
    const {
        motionGraphics = [],
        mgScenes = [],
        scenes = [],
        scriptContext = {},
        fps = 30,
    } = opts;

    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    // Build job list from overlay MGs + fullscreen MG scenes
    const jobs = [];

    // Overlay MGs
    for (let i = 0; i < motionGraphics.length; i++) {
        const mg = { ...motionGraphics[i] };
        const isFullScreen = false;
        const tile = getTileDimensions(mg, isFullScreen);
        const hash = computeJobHash(mg, fps, tile.w, tile.h, isFullScreen);
        jobs.push({ mg, isFullScreen, hash, tile, category: 'overlay', index: i });
    }

    // Fullscreen MG scenes
    for (let i = 0; i < mgScenes.length; i++) {
        const sceneData = mgScenes[i];
        const mg = { ...sceneData };
        // Clean scene-only keys
        for (const key of ['isMGScene', 'trackId', 'mediaType', 'keyword', 'sceneIndex', 'index',
                           'mediaFile', 'originalStartTime', 'originalEndTime']) {
            delete mg[key];
        }
        const isFullScreen = true;
        const tile = getTileDimensions(mg, isFullScreen);
        const hash = computeJobHash(mg, fps, tile.w, tile.h, isFullScreen);
        jobs.push({ mg, isFullScreen, hash, tile, category: 'fullscreen', index: i });
    }

    // Also check scenes array for isMGScene scenes not in mgScenes
    for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        if (!scene.isMGScene) continue;
        // Skip if already in mgScenes (check by type+text combo)
        const alreadyAdded = jobs.some(j => j.category === 'fullscreen' &&
            j.mg.type === scene.type && j.mg.text === scene.text);
        if (alreadyAdded) continue;

        const mg = { ...scene };
        for (const key of ['isMGScene', 'trackId', 'mediaType', 'keyword', 'sceneIndex', 'index',
                           'mediaFile', 'originalStartTime', 'originalEndTime']) {
            delete mg[key];
        }
        const isFullScreen = true;
        const tile = getTileDimensions(mg, isFullScreen);
        const hash = computeJobHash(mg, fps, tile.w, tile.h, isFullScreen);
        jobs.push({ mg, isFullScreen, hash, tile, category: 'fullscreen', index: jobs.filter(j => j.category === 'fullscreen').length });
    }

    log(`${jobs.length} MG jobs (${jobs.filter(j => !j.isFullScreen).length} overlay, ${jobs.filter(j => j.isFullScreen).length} fullscreen)`);

    // Check cache and partition into canvas vs Remotion
    const canvasJobs = [];
    const remotionJobs = [];
    const cachedResults = [];

    for (const job of jobs) {
        const jobDir = path.join(cacheDir, job.hash);
        const manifestPath = path.join(jobDir, 'manifest.json');

        // Check cache
        if (fs.existsSync(manifestPath)) {
            try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                if (manifest.complete) {
                    log(`Cache HIT: ${job.mg.type} [${job.hash}]`);
                    cachedResults.push({ job, manifest, jobDir });
                    continue;
                }
            } catch (_) {}
        }

        // Cache miss — need to render
        if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });

        if (canRenderWithCanvas(job.mg.type)) {
            canvasJobs.push({ ...job, jobDir });
        } else {
            remotionJobs.push({ ...job, jobDir });
        }
    }

    log(`Cache: ${cachedResults.length} hit, ${canvasJobs.length} canvas, ${remotionJobs.length} remotion`);

    // Render canvas jobs
    if (canvasJobs.length > 0) {
        progressCb(5, `Rendering ${canvasJobs.length} canvas MGs...`);
        let done = 0;
        const canvasFns = canvasJobs.map(job => async () => {
            const totalFrames = await renderCanvasMG(
                job.mg, job.jobDir, fps, scriptContext,
                job.tile.w, job.tile.h, job.isFullScreen
            );
            // Write manifest
            const manifest = {
                hash: job.hash,
                type: job.mg.type,
                frameCount: totalFrames,
                fps,
                width: job.tile.w,
                height: job.tile.h,
                premultipliedAlpha: true,
                complete: true,
            };
            fs.writeFileSync(path.join(job.jobDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
            done++;
            progressCb(5 + Math.round((done / canvasJobs.length) * 40), `Canvas MG ${done}/${canvasJobs.length}`);
            return { job, manifest, jobDir: job.jobDir };
        });

        const canvasResults = await runWithConcurrency(canvasFns, CANVAS_CONCURRENCY);
        cachedResults.push(...canvasResults);
    }

    // Render Remotion jobs
    if (remotionJobs.length > 0) {
        progressCb(50, `Rendering ${remotionJobs.length} Remotion MGs...`);
        let done = 0;
        const remotionFns = remotionJobs.map(job => async () => {
            const totalFrames = await renderRemotionMG(
                job.mg, job.jobDir, fps, scriptContext,
                job.tile.w, job.tile.h, job.isFullScreen
            );
            const manifest = {
                hash: job.hash,
                type: job.mg.type,
                frameCount: totalFrames,
                fps,
                width: job.tile.w,
                height: job.tile.h,
                premultipliedAlpha: false,
                complete: true,
            };
            fs.writeFileSync(path.join(job.jobDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
            done++;
            progressCb(50 + Math.round((done / remotionJobs.length) * 40), `Remotion MG ${done}/${remotionJobs.length}`);
            return { job, manifest, jobDir: job.jobDir };
        });

        const remotionResults = await runWithConcurrency(remotionFns, REMOTION_CONCURRENCY);
        cachedResults.push(...remotionResults);
    }

    // Build output layers
    const layers = cachedResults.map(r => ({
        seqDir: r.jobDir,
        seqPattern: 'frame_%06d.png',
        seqFrameCount: r.manifest.frameCount,
        seqLocalStart: 0,
        tileW: r.manifest.width,
        tileH: r.manifest.height,
        isFullScreen: r.job.isFullScreen,
        mgType: r.job.mg.type,
        mgIndex: r.job.index,
        category: r.job.category,
    }));

    progressCb(100, `Done: ${layers.length} MG sequences`);
    log(`Output: ${layers.length} imageSequence layers`);

    return { layers };
}

module.exports = { renderMGsToPNG, getTileDimensions, computeJobHash };
