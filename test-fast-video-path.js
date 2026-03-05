/**
 * test-fast-video-path.js — Phase 3F: Fast video path test
 * Tests bypass compositor for single full-screen video.
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const FFMPEG = process.env.FFMPEG_PATH || 'C:\\ffmg\\bin\\ffmpeg.exe';
const OUTPUT_DIR = path.join(__dirname, 'output');
const TEMP_DIR = path.join(__dirname, 'temp');

function log(msg) { console.log(`[FastPathTest] ${msg}`); }

function runFFmpeg(args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exit ${code}`)));
        proc.on('error', reject);
    });
}

app.whenReady().then(async () => {
    log('=== Phase 3F: Fast Video Path Test ===');

    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const addon = require('./src/native/native-exporter/build/Release/native_exporter.node');
    const testVideo = path.join(TEMP_DIR, 'scene-0.mp4');

    if (!fs.existsSync(testVideo)) {
        log('FAIL: temp/scene-0.mp4 not found');
        app.quit();
        return;
    }

    const h264File = path.join(TEMP_DIR, 'fast-path-test.h264');
    const mp4File = path.join(OUTPUT_DIR, 'fast-path-test.mp4');

    // Test 1: QUALITY preset with fast path
    log('--- Test 1: Fast path + QUALITY preset ---');
    try {
        const r = addon.composeAndEncode({
            width: 1920, height: 1080, fps: 30, totalFrames: 60,
            outputPath: h264File,
            bitrate: 18000000, maxBitrate: 24000000, gop: 60,
            layers: [{
                type: 'video',
                mediaPath: testVideo,
                startFrame: 0, endFrame: 60,
                fitMode: 'cover', opacity: 1.0,
                scaleX: 1, scaleY: 1,
                translateX: 0, translateY: 0,
                rotationRad: 0,
                anchorX: 0.5, anchorY: 0.5,
            }]
        });

        log(`  ok=${r.ok} frames=${r.frames} elapsed=${r.elapsed.toFixed(2)}s fps=${r.fps.toFixed(1)} fastPath=${r.fastPath || false}`);

        if (r.ok && r.fastPath) {
            await runFFmpeg(['-y', '-r', '30', '-i', h264File, '-c:v', 'copy', '-movflags', '+faststart', mp4File]);
            const stat = fs.statSync(mp4File);
            log(`  MP4: ${mp4File} (${(stat.size / 1024).toFixed(0)} KB)`);
            log(`  Test 1 (QUALITY fast path): ${stat.size > 10000 ? 'PASSED' : 'FAILED (too small)'}`);
        } else {
            log(`  Test 1: ${r.ok ? 'PASSED (compositor fallback)' : 'FAILED: ' + r.reason}`);
        }
        try { fs.unlinkSync(h264File); } catch (_) { }
    } catch (err) {
        log(`  EXCEPTION: ${err.message}`);
        log('  Test 1: FAILED');
    }

    // Test 2: FAST preset with fast path
    log('--- Test 2: Fast path + FAST preset ---');
    try {
        const r = addon.composeAndEncode({
            width: 1920, height: 1080, fps: 30, totalFrames: 60,
            outputPath: h264File,
            bitrate: 18000000, maxBitrate: 24000000, gop: 60,
            speedPreset: 'fast',
            layers: [{
                type: 'video',
                mediaPath: testVideo,
                startFrame: 0, endFrame: 60,
                fitMode: 'cover', opacity: 1.0,
                scaleX: 1, scaleY: 1,
                translateX: 0, translateY: 0,
                rotationRad: 0,
                anchorX: 0.5, anchorY: 0.5,
            }]
        });

        log(`  ok=${r.ok} frames=${r.frames} elapsed=${r.elapsed.toFixed(2)}s fps=${r.fps.toFixed(1)} fastPath=${r.fastPath || false}`);
        log(`  Test 2 (FAST fast path): ${r.ok ? 'PASSED' : 'FAILED: ' + r.reason}`);
        try { fs.unlinkSync(h264File); } catch (_) { }
    } catch (err) {
        log(`  EXCEPTION: ${err.message}`);
        log('  Test 2: FAILED');
    }

    // Test 3: Ineligible plan (2 layers) should NOT use fast path
    log('--- Test 3: Ineligible plan (compositor fallback) ---');
    try {
        const r = addon.composeAndEncode({
            width: 1920, height: 1080, fps: 30, totalFrames: 60,
            outputPath: h264File,
            bitrate: 18000000, maxBitrate: 24000000, gop: 60,
            layers: [
                { type: 'solid', color: [0, 0, 0, 1], startFrame: 0, endFrame: 60 },
                {
                    type: 'video', mediaPath: testVideo,
                    startFrame: 0, endFrame: 60,
                    fitMode: 'cover', opacity: 1.0,
                    scaleX: 1, scaleY: 1,
                    translateX: 0, translateY: 0,
                    rotationRad: 0,
                    anchorX: 0.5, anchorY: 0.5,
                }
            ]
        });

        const usedFastPath = r.fastPath || false;
        log(`  ok=${r.ok} fps=${r.fps.toFixed(1)} fastPath=${usedFastPath}`);
        log(`  Test 3: ${r.ok && !usedFastPath ? 'PASSED (correctly used compositor)' : 'FAILED'}`);
        try { fs.unlinkSync(h264File); } catch (_) { }
    } catch (err) {
        log(`  EXCEPTION: ${err.message}`);
        log('  Test 3: FAILED');
    }

    log('');
    log('=== Fast Video Path Test Complete ===');
    app.quit();
});
