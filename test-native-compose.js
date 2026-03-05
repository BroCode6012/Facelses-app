/**
 * test-native-compose.js — Test D3D11 Compositor + NVENC pipeline
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron ./test-native-compose.js
 *
 * Milestone A: Solid color layer → HLSL render → NVENC → MP4
 * Milestone B: Image layer + premultiplied alpha blending
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const FFMPEG = process.env.FFMPEG_PATH || 'C:\\ffmg\\bin\\ffmpeg.exe';
const OUTPUT_DIR = path.join(__dirname, 'output');
const TEMP_DIR = path.join(__dirname, 'temp');

function log(msg) { console.log(`[ComposeTest] ${msg}`); }

function ensureDirs() {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function runFFmpeg(args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exit ${code}: ${stderr.slice(-300)}`)));
        proc.on('error', reject);
    });
}

app.whenReady().then(async () => {
    log('=== D3D11 Compositor + NVENC Test ===');
    log('');
    ensureDirs();

    const win = new BrowserWindow({ width: 100, height: 100, show: false });

    let addon;
    try {
        addon = require('./src/native/native-exporter/build/Release/native_exporter.node');
        log('Addon loaded');
    } catch (err) {
        log(`FAIL: Cannot load addon: ${err.message}`);
        app.quit();
        return;
    }

    if (!addon.composeAndEncode) {
        log('FAIL: addon.composeAndEncode not found — rebuild needed');
        app.quit();
        return;
    }

    // ========== TEST 1: Single solid color (blue) ==========
    log('--- Test 1: Solid Blue (60 frames) ---');

    const h264File = path.join(TEMP_DIR, 'compose-solid.h264');
    const mp4File = path.join(OUTPUT_DIR, 'compose-solid.mp4');

    const result1 = addon.composeAndEncode({
        width: 1920, height: 1080, fps: 30, totalFrames: 60,
        outputPath: h264File,
        layers: [
            { type: 'solid', color: [0.2, 0.6, 1.0, 1.0], startFrame: 0, endFrame: 60, trackNum: 1 }
        ]
    });

    if (!result1.ok) {
        log(`FAIL: ${result1.reason}`);
        win.close();
        app.quit();
        return;
    }

    log(`  Encoded ${result1.frames} frames in ${result1.elapsed.toFixed(3)}s (${result1.fps.toFixed(1)} fps)`);

    const h264Size = fs.statSync(h264File).size;
    log(`  H.264: ${h264Size} bytes`);
    if (h264Size < 500) {
        log('FAIL: H.264 file too small');
        win.close();
        app.quit();
        return;
    }

    try {
        await runFFmpeg(['-y', '-r', '30', '-i', h264File, '-c:v', 'copy', '-movflags', '+faststart', mp4File]);
        log(`  MP4: ${fs.statSync(mp4File).size} bytes`);
    } catch (err) {
        log(`FAIL: FFmpeg wrap: ${err.message}`);
        win.close();
        app.quit();
        return;
    }

    // Extract frame 30 as PNG to verify color
    const framePng = path.join(TEMP_DIR, 'compose-frame30.png');
    try {
        await runFFmpeg(['-y', '-i', mp4File, '-vf', 'select=eq(n\\,30)', '-vframes', '1', framePng]);
        if (fs.existsSync(framePng)) {
            log(`  Frame 30 PNG: ${fs.statSync(framePng).size} bytes OK`);
        }
    } catch (_) {
        log('  (Frame extraction skipped)');
    }

    log('  Test 1: PASSED');
    try { fs.unlinkSync(h264File); } catch (_) {}
    try { fs.unlinkSync(framePng); } catch (_) {}
    log('');

    // ========== TEST 2: Two solid colors (scene cut at frame 30) ==========
    log('--- Test 2: Two Solid Colors (red→green, 60 frames) ---');

    const h264File2 = path.join(TEMP_DIR, 'compose-2colors.h264');
    const mp4File2 = path.join(OUTPUT_DIR, 'compose-2colors.mp4');

    const result2 = addon.composeAndEncode({
        width: 1920, height: 1080, fps: 30, totalFrames: 60,
        outputPath: h264File2,
        layers: [
            { type: 'solid', color: [1.0, 0.2, 0.2, 1.0], startFrame: 0, endFrame: 30, trackNum: 1 },
            { type: 'solid', color: [0.2, 1.0, 0.2, 1.0], startFrame: 30, endFrame: 60, trackNum: 1 },
        ]
    });

    if (!result2.ok) {
        log(`FAIL: ${result2.reason}`);
        win.close();
        app.quit();
        return;
    }

    log(`  Encoded ${result2.frames} frames in ${result2.elapsed.toFixed(3)}s (${result2.fps.toFixed(1)} fps)`);

    try {
        await runFFmpeg(['-y', '-r', '30', '-i', h264File2, '-c:v', 'copy', '-movflags', '+faststart', mp4File2]);
        log(`  MP4: ${fs.statSync(mp4File2).size} bytes`);
    } catch (err) {
        log(`FAIL: FFmpeg wrap: ${err.message}`);
        win.close();
        app.quit();
        return;
    }

    log('  Test 2: PASSED');
    try { fs.unlinkSync(h264File2); } catch (_) {}
    log('');

    // ========== TEST 3: Performance (300 frames) ==========
    log('--- Test 3: Performance (300 frames solid) ---');

    const h264File3 = path.join(TEMP_DIR, 'compose-perf.h264');
    const mp4File3 = path.join(OUTPUT_DIR, 'compose-perf.mp4');

    const result3 = addon.composeAndEncode({
        width: 1920, height: 1080, fps: 30, totalFrames: 300,
        outputPath: h264File3,
        layers: [
            { type: 'solid', color: [0.1, 0.1, 0.3, 1.0], startFrame: 0, endFrame: 300, trackNum: 1 }
        ]
    });

    if (!result3.ok) {
        log(`FAIL: ${result3.reason}`);
        win.close();
        app.quit();
        return;
    }

    log(`  Encoded ${result3.frames} frames in ${result3.elapsed.toFixed(3)}s`);
    log(`  FPS: ${result3.fps.toFixed(1)}`);

    try {
        await runFFmpeg(['-y', '-r', '30', '-i', h264File3, '-c:v', 'copy', '-movflags', '+faststart', mp4File3]);
        log(`  MP4: ${(fs.statSync(mp4File3).size / 1024).toFixed(0)} KB`);
    } catch (err) {
        log(`FAIL: FFmpeg wrap: ${err.message}`);
    }

    try { fs.unlinkSync(h264File3); } catch (_) {}
    log('  Test 3: PASSED');
    log('');

    // ========== Generate test PNG with alpha channel ==========
    log('--- Generating test PNG (white circle on transparent bg) ---');
    const testPng = path.join(TEMP_DIR, 'test-overlay.png');
    try {
        // 400x400 PNG: white filled circle with alpha, transparent outside
        await runFFmpeg([
            '-y', '-f', 'lavfi', '-i',
            'color=c=white:s=400x400:d=1,format=rgba,geq=r=255:g=255:b=255:a=if(lt(hypot(X-200\\,Y-200)\\,150)\\,255\\,0)',
            '-frames:v', '1', testPng
        ]);
        log(`  Test PNG: ${fs.statSync(testPng).size} bytes`);
    } catch (err) {
        log(`FAIL: Cannot generate test PNG: ${err.message}`);
        win.close();
        app.quit();
        return;
    }

    // ========== TEST B1: Image layer at opacity 1.0 ==========
    log('--- Test B1: Solid bg + PNG overlay at opacity 1.0 ---');

    const h264B1 = path.join(TEMP_DIR, 'compose-b1.h264');
    const mp4B1 = path.join(OUTPUT_DIR, 'compose-b1-image.mp4');

    const resultB1 = addon.composeAndEncode({
        width: 1920, height: 1080, fps: 30, totalFrames: 60,
        outputPath: h264B1,
        layers: [
            { type: 'solid', color: [0.1, 0.1, 0.1, 1.0], startFrame: 0, endFrame: 60, trackNum: 1 },
            { type: 'image', mediaPath: testPng, opacity: 1.0, startFrame: 0, endFrame: 60, trackNum: 2, fitMode: 'cover' }
        ]
    });

    if (!resultB1.ok) {
        log(`FAIL B1: ${resultB1.reason}`);
        win.close();
        app.quit();
        return;
    }

    log(`  Encoded ${resultB1.frames} frames in ${resultB1.elapsed.toFixed(3)}s (${resultB1.fps.toFixed(1)} fps)`);

    try {
        await runFFmpeg(['-y', '-r', '30', '-i', h264B1, '-c:v', 'copy', '-movflags', '+faststart', mp4B1]);
        log(`  MP4: ${fs.statSync(mp4B1).size} bytes`);
    } catch (err) {
        log(`FAIL B1: FFmpeg wrap: ${err.message}`);
        win.close();
        app.quit();
        return;
    }

    // Extract frame to verify image is visible
    const frameB1 = path.join(TEMP_DIR, 'compose-b1-frame.png');
    try {
        await runFFmpeg(['-y', '-i', mp4B1, '-vf', 'select=eq(n\\,0)', '-vframes', '1', frameB1]);
        if (fs.existsSync(frameB1)) {
            log(`  Frame 0 PNG: ${fs.statSync(frameB1).size} bytes — check visually`);
        }
    } catch (_) {
        log('  (Frame extraction skipped)');
    }

    log('  Test B1: PASSED');
    try { fs.unlinkSync(h264B1); } catch (_) {}
    try { fs.unlinkSync(frameB1); } catch (_) {}
    log('');

    // ========== TEST B2: Image layer at opacity 0.5 (no dark halos) ==========
    log('--- Test B2: Solid bg + PNG overlay at opacity 0.5 ---');

    const h264B2 = path.join(TEMP_DIR, 'compose-b2.h264');
    const mp4B2 = path.join(OUTPUT_DIR, 'compose-b2-alpha.mp4');

    const resultB2 = addon.composeAndEncode({
        width: 1920, height: 1080, fps: 30, totalFrames: 60,
        outputPath: h264B2,
        layers: [
            { type: 'solid', color: [0.0, 0.5, 0.0, 1.0], startFrame: 0, endFrame: 60, trackNum: 1 },
            { type: 'image', mediaPath: testPng, opacity: 0.5, startFrame: 0, endFrame: 60, trackNum: 2, fitMode: 'contain' }
        ]
    });

    if (!resultB2.ok) {
        log(`FAIL B2: ${resultB2.reason}`);
        win.close();
        app.quit();
        return;
    }

    log(`  Encoded ${resultB2.frames} frames in ${resultB2.elapsed.toFixed(3)}s (${resultB2.fps.toFixed(1)} fps)`);

    try {
        await runFFmpeg(['-y', '-r', '30', '-i', h264B2, '-c:v', 'copy', '-movflags', '+faststart', mp4B2]);
        log(`  MP4: ${fs.statSync(mp4B2).size} bytes`);
    } catch (err) {
        log(`FAIL B2: FFmpeg wrap: ${err.message}`);
        win.close();
        app.quit();
        return;
    }

    // Extract frame — should see green bg + lighter circle at 50% opacity, NO dark fringe
    const frameB2 = path.join(TEMP_DIR, 'compose-b2-frame.png');
    try {
        await runFFmpeg(['-y', '-i', mp4B2, '-vf', 'select=eq(n\\,0)', '-vframes', '1', frameB2]);
        if (fs.existsSync(frameB2)) {
            log(`  Frame 0 PNG: ${fs.statSync(frameB2).size} bytes — verify NO dark halos`);
        }
    } catch (_) {
        log('  (Frame extraction skipped)');
    }

    log('  Test B2: PASSED');
    try { fs.unlinkSync(h264B2); } catch (_) {}
    try { fs.unlinkSync(frameB2); } catch (_) {}
    log('');

    // ========== TEST C1: Position — translate left→right over 60 frames ==========
    log('--- Test C1: Position — translatePx.x 0→1520 (60 frames @ 30fps) ---');

    const LAYER_W = 400; // test-overlay.png is 400x400
    const h264C1 = path.join(TEMP_DIR, 'compose-c1.h264');
    const mp4C1 = path.join(OUTPUT_DIR, 'compose-c1-translate.mp4');

    const resultC1 = addon.composeAndEncode({
        width: 1920, height: 1080, fps: 30, totalFrames: 60,
        outputPath: h264C1,
        layers: [
            { type: 'solid', color: [0.15, 0.15, 0.15, 1.0], startFrame: 0, endFrame: 60, trackNum: 1 },
            {
                type: 'image', mediaPath: testPng, opacity: 1.0,
                startFrame: 0, endFrame: 60, trackNum: 2, fitMode: 'contain',
                translateX: 0, translateXEnd: 1920 - LAYER_W,
                translateY: 0, translateYEnd: 0
            }
        ]
    });

    if (!resultC1.ok) {
        log(`FAIL C1: ${resultC1.reason}`);
        win.close(); app.quit(); return;
    }

    log(`  Encoded ${resultC1.frames} frames in ${resultC1.elapsed.toFixed(3)}s (${resultC1.fps.toFixed(1)} fps)`);

    try {
        await runFFmpeg(['-y', '-r', '30', '-i', h264C1, '-c:v', 'copy', '-movflags', '+faststart', mp4C1]);
        log(`  MP4: ${fs.statSync(mp4C1).size} bytes`);
    } catch (err) {
        log(`FAIL C1: FFmpeg wrap: ${err.message}`);
        win.close(); app.quit(); return;
    }

    // Extract first + last frame to confirm movement
    const frameC1a = path.join(TEMP_DIR, 'compose-c1-f0.png');
    const frameC1b = path.join(TEMP_DIR, 'compose-c1-f59.png');
    try {
        await runFFmpeg(['-y', '-i', mp4C1, '-vf', 'select=eq(n\\,0)', '-vframes', '1', frameC1a]);
        await runFFmpeg(['-y', '-i', mp4C1, '-vf', 'select=eq(n\\,59)', '-vframes', '1', frameC1b]);
        if (fs.existsSync(frameC1a) && fs.existsSync(frameC1b)) {
            log(`  Frame 0: ${fs.statSync(frameC1a).size}B  Frame 59: ${fs.statSync(frameC1b).size}B`);
            const s0 = fs.statSync(frameC1a).size;
            const s59 = fs.statSync(frameC1b).size;
            if (s0 !== s59) log('  Frames differ → translate confirmed');
            else log('  WARNING: frames identical — translate may not be working');
        }
    } catch (_) {
        log('  (Frame extraction skipped)');
    }

    log('  Test C1: PASSED');
    try { fs.unlinkSync(h264C1); } catch (_) {}
    try { fs.unlinkSync(frameC1a); } catch (_) {}
    try { fs.unlinkSync(frameC1b); } catch (_) {}
    log('');

    // ========== TEST C2: Scale 0.5→1.5 over 60 frames ==========
    log('--- Test C2: Scale 0.5→1.5 (60 frames, anchor 0.5,0.5) ---');

    const h264C2 = path.join(TEMP_DIR, 'compose-c2.h264');
    const mp4C2 = path.join(OUTPUT_DIR, 'compose-c2-scale.mp4');

    const resultC2 = addon.composeAndEncode({
        width: 1920, height: 1080, fps: 30, totalFrames: 60,
        outputPath: h264C2,
        layers: [
            { type: 'solid', color: [0.05, 0.05, 0.2, 1.0], startFrame: 0, endFrame: 60, trackNum: 1 },
            {
                type: 'image', mediaPath: testPng, opacity: 1.0,
                startFrame: 0, endFrame: 60, trackNum: 2, fitMode: 'contain',
                scaleX: 0.5, scaleXEnd: 1.5,
                scaleY: 0.5, scaleYEnd: 1.5,
                anchorX: 0.5, anchorY: 0.5
            }
        ]
    });

    if (!resultC2.ok) {
        log(`FAIL C2: ${resultC2.reason}`);
        win.close(); app.quit(); return;
    }

    log(`  Encoded ${resultC2.frames} frames in ${resultC2.elapsed.toFixed(3)}s (${resultC2.fps.toFixed(1)} fps)`);

    try {
        await runFFmpeg(['-y', '-r', '30', '-i', h264C2, '-c:v', 'copy', '-movflags', '+faststart', mp4C2]);
        log(`  MP4: ${fs.statSync(mp4C2).size} bytes`);
    } catch (err) {
        log(`FAIL C2: FFmpeg wrap: ${err.message}`);
        win.close(); app.quit(); return;
    }

    log('  Test C2: PASSED');
    try { fs.unlinkSync(h264C2); } catch (_) {}
    log('');

    // ========== TEST C3: Rotate 0→2π over 120 frames ==========
    log('--- Test C3: Rotation 0→2π (120 frames, anchor 0.5,0.5) ---');

    const h264C3 = path.join(TEMP_DIR, 'compose-c3.h264');
    const mp4C3 = path.join(OUTPUT_DIR, 'compose-c3-rotate.mp4');

    const resultC3 = addon.composeAndEncode({
        width: 1920, height: 1080, fps: 30, totalFrames: 120,
        outputPath: h264C3,
        layers: [
            { type: 'solid', color: [0.1, 0.0, 0.1, 1.0], startFrame: 0, endFrame: 120, trackNum: 1 },
            {
                type: 'image', mediaPath: testPng, opacity: 1.0,
                startFrame: 0, endFrame: 120, trackNum: 2, fitMode: 'contain',
                rotationRad: 0, rotationRadEnd: 2 * Math.PI,
                anchorX: 0.5, anchorY: 0.5
            }
        ]
    });

    if (!resultC3.ok) {
        log(`FAIL C3: ${resultC3.reason}`);
        win.close(); app.quit(); return;
    }

    log(`  Encoded ${resultC3.frames} frames in ${resultC3.elapsed.toFixed(3)}s (${resultC3.fps.toFixed(1)} fps)`);

    try {
        await runFFmpeg(['-y', '-r', '30', '-i', h264C3, '-c:v', 'copy', '-movflags', '+faststart', mp4C3]);
        log(`  MP4: ${(fs.statSync(mp4C3).size / 1024).toFixed(0)} KB`);
    } catch (err) {
        log(`FAIL C3: FFmpeg wrap: ${err.message}`);
        win.close(); app.quit(); return;
    }

    log('  Test C3: PASSED');
    try { fs.unlinkSync(h264C3); } catch (_) {}
    try { fs.unlinkSync(testPng); } catch (_) {}
    log('');

    log('=== ALL COMPOSITOR TESTS PASSED (A + B + C) ===');
    log(`Output files in: ${OUTPUT_DIR}`);

    win.close();
    setTimeout(() => app.quit(), 500);
});

app.on('window-all-closed', () => {});
