/**
 * test-native-compose-video.js — Smoke test for MF video decoding in compositor
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron ./test-native-compose-video.js
 *
 * Phase 3A: Decode MP4 (H.264) via Media Foundation → D3D11 texture → NVENC
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const FFMPEG = process.env.FFMPEG_PATH || 'C:\\ffmg\\bin\\ffmpeg.exe';
const OUTPUT_DIR = path.join(__dirname, 'output');
const TEMP_DIR = path.join(__dirname, 'temp');

function log(msg) { console.log(`[VideoTest] ${msg}`); }

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
    log('=== Phase 3A: Video Decode Smoke Test ===');
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
        log('FAIL: addon.composeAndEncode not found');
        app.quit();
        return;
    }

    // Find a test video — use temp/scene-0.mp4 if it exists
    const testVideoPath = path.join(TEMP_DIR, 'scene-0.mp4');
    if (!fs.existsSync(testVideoPath)) {
        log(`FAIL: Test video not found at ${testVideoPath}`);
        log('Please ensure temp/scene-0.mp4 exists (run a build first)');
        app.quit();
        return;
    }
    log(`Test video: ${testVideoPath}`);

    // ========== SMOKE TEST: Video layer full-screen ==========
    log('--- Smoke Test: Video layer full-screen (60 frames @30fps) ---');

    const h264File = path.join(TEMP_DIR, 'compose-video-smoke.h264');
    const mp4File = path.join(OUTPUT_DIR, 'compose-video-smoke.mp4');

    try {
        const result = addon.composeAndEncode({
            width: 1920,
            height: 1080,
            fps: 30,
            totalFrames: 60,
            outputPath: h264File,
            bitrate: 18000000,
            maxBitrate: 24000000,
            gop: 60,
            bframes: 2,
            preset: 5,
            rc: 'vbr_hq',
            layers: [
                // Background solid black
                {
                    type: 'solid',
                    color: [0, 0, 0, 1],
                    startFrame: 0,
                    endFrame: 60,
                },
                // Video layer — full-screen, cover mode
                {
                    type: 'video',
                    mediaPath: testVideoPath,
                    startFrame: 0,
                    endFrame: 60,
                    fitMode: 'cover',
                    translateX: 0, translateY: 0,
                    scaleX: 1, scaleY: 1,
                    rotationRad: 0,
                    opacity: 1.0,
                    anchorX: 0.5, anchorY: 0.5,
                },
            ],
        });

        if (!result.ok) {
            log(`  ENCODE FAILED: ${result.reason}`);
            log('  Test Smoke: FAILED');
            app.quit();
            return;
        }

        log(`  Encoded ${result.frames} frames in ${result.elapsed.toFixed(2)}s (${result.fps.toFixed(1)} fps)`);
        log(`  H.264 file: ${h264File}`);

        // Wrap to MP4
        await runFFmpeg([
            '-y', '-r', '30',
            '-i', h264File,
            '-c:v', 'copy',
            '-movflags', '+faststart',
            mp4File
        ]);

        const stat = fs.statSync(mp4File);
        log(`  MP4 output: ${mp4File} (${(stat.size / 1024).toFixed(0)} KB)`);

        if (stat.size > 10000) {
            log('  Test Smoke: PASSED');
        } else {
            log('  Test Smoke: FAILED (output too small)');
        }

        // Cleanup h264
        try { fs.unlinkSync(h264File); } catch (_) { }

    } catch (err) {
        log(`  EXCEPTION: ${err.message}`);
        log('  Test Smoke: FAILED');
    }

    log('');
    log('=== Video Decode Smoke Test Complete ===');
    app.quit();
});
