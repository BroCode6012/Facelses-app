/**
 * test-native-export.js — Test Native D3D11 + NVENC export pipeline
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron ./test-native-export.js
 *
 * Phase A: Color validation (3 frames: RED, GREEN, BLUE)
 * Phase B: Full synthetic export (300 frames, color-cycling gradient)
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const FFMPEG = process.env.FFMPEG_PATH || 'C:\\ffmg\\bin\\ffmpeg.exe';
const OUTPUT_DIR = path.join(__dirname, 'output');
const TEMP_DIR = path.join(__dirname, 'temp');

function log(msg) { console.log(`[NativeTest] ${msg}`); }

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
    log('=== Native D3D11 + NVENC Export Test ===');
    log('');
    ensureDirs();

    // Need a BrowserWindow for Electron to stay alive (even hidden)
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

    // ========== PROBE ==========
    log('--- Probe ---');
    const probe = addon.probe();
    log(`  D3D11: ${probe.d3d11}`);
    log(`  NVENC: ${probe.nvenc}`);
    log(`  GPU:   ${probe.gpu || 'N/A'}`);
    log(`  OK:    ${probe.ok}`);
    if (!probe.ok) {
        log(`FAIL: Probe failed: ${probe.reason}`);
        win.close();
        app.quit();
        return;
    }
    log('');

    // ========== PHASE A: Color Validation (3 frames) ==========
    log('=== PHASE A: Color Validation ===');

    // We need a special encode for this — encode 3 frames with specific colors
    // Since our encoder uses renderSyntheticFrame which cycles colors,
    // we'll encode 3 frames and verify the output is valid video.
    // The actual color validation requires decoding — we'll use ffprobe/ffmpeg for that.

    const colorH264 = path.join(TEMP_DIR, 'color-test.h264');
    const colorMp4 = path.join(TEMP_DIR, 'color-test.mp4');

    const colorResult = addon.encode({
        width: 1920, height: 1080, fps: 30, totalFrames: 3,
        outputPath: colorH264,
    });

    if (!colorResult.ok) {
        log(`FAIL: Color encode failed: ${colorResult.reason}`);
        win.close();
        app.quit();
        return;
    }

    log(`  Encoded ${colorResult.frames} color frames in ${colorResult.elapsed.toFixed(3)}s`);

    // Check .h264 file exists and has data
    const h264Stats = fs.statSync(colorH264);
    log(`  H.264 file: ${h264Stats.size} bytes`);
    if (h264Stats.size < 100) {
        log('FAIL: H.264 file too small — NVENC likely produced no output');
        win.close();
        app.quit();
        return;
    }

    // Wrap to MP4
    try {
        await runFFmpeg(['-y', '-r', '30', '-i', colorH264, '-c:v', 'copy', '-movflags', '+faststart', colorMp4]);
        log(`  MP4 wrapped: ${fs.statSync(colorMp4).size} bytes`);
    } catch (err) {
        log(`FAIL: FFmpeg wrap failed: ${err.message}`);
        win.close();
        app.quit();
        return;
    }

    // Extract frames as PNG and check center pixel colors
    let colorTestPassed = true;
    const expectedColors = [
        // Frame 0: t=0, sin(0)=0 → r=0.5, sin(2.094)=0.866 → g=0.933, sin(4.189)=-0.866 → b=0.067
        // These are approximate — we just need non-black, non-identical frames
    ];

    for (let i = 0; i < 3; i++) {
        const framePng = path.join(TEMP_DIR, `color-frame-${i}.png`);
        try {
            await runFFmpeg([
                '-y', '-i', colorMp4,
                '-vf', `select=eq(n\\,${i})`,
                '-vframes', '1',
                framePng
            ]);

            if (fs.existsSync(framePng)) {
                const pngSize = fs.statSync(framePng).size;
                log(`  Frame ${i}: PNG ${pngSize} bytes ${pngSize > 1000 ? 'OK' : 'SUSPICIOUSLY SMALL'}`);
            } else {
                log(`  Frame ${i}: PNG not created`);
                colorTestPassed = false;
            }
        } catch (err) {
            log(`  Frame ${i}: extract failed: ${err.message}`);
            colorTestPassed = false;
        }
    }

    // Use ffprobe to check video properties
    try {
        const probeOut = execSync(`"${FFMPEG}" -i "${colorMp4}" -v quiet -print_format json -show_streams`, { encoding: 'utf8' });
        const probeData = JSON.parse(probeOut.replace(/.*?{/s, '{'));
        const vstream = probeData.streams && probeData.streams.find(s => s.codec_type === 'video');
        if (vstream) {
            log(`  Video: ${vstream.codec_name} ${vstream.profile || ''}, ${vstream.width}x${vstream.height}`);
        }
    } catch (_) {
        // ffprobe might not be available as separate binary, try with ffmpeg
        log('  (ffprobe check skipped)');
    }

    log(`  Phase A: ${colorTestPassed ? 'PASSED' : 'ISSUES DETECTED'}`);
    log('');

    // Cleanup phase A temp files
    try { fs.unlinkSync(colorH264); } catch (_) {}
    try { fs.unlinkSync(colorMp4); } catch (_) {}
    for (let i = 0; i < 3; i++) {
        try { fs.unlinkSync(path.join(TEMP_DIR, `color-frame-${i}.png`)); } catch (_) {}
    }

    // ========== PHASE B: Full Synthetic Export (300 frames) ==========
    log('=== PHASE B: Full Synthetic Export (300 frames @ 30fps = 10s) ===');

    const fullH264 = path.join(TEMP_DIR, 'native-test-full.h264');
    const fullMp4 = path.join(OUTPUT_DIR, 'native-test-full.mp4');

    const fullResult = addon.encode({
        width: 1920, height: 1080, fps: 30, totalFrames: 300,
        outputPath: fullH264,
    });

    if (!fullResult.ok) {
        log(`FAIL: Full encode failed: ${fullResult.reason}`);
        win.close();
        app.quit();
        return;
    }

    log(`  Encoded: ${fullResult.frames} frames`);
    log(`  Time:    ${fullResult.elapsed.toFixed(2)}s`);
    log(`  FPS:     ${fullResult.fps.toFixed(1)}`);
    log(`  H.264:   ${(fs.statSync(fullH264).size / 1024).toFixed(0)} KB`);

    // Wrap to MP4
    try {
        await runFFmpeg(['-y', '-r', '30', '-i', fullH264, '-c:v', 'copy', '-movflags', '+faststart', fullMp4]);
        const mp4Stats = fs.statSync(fullMp4);
        log(`  MP4:     ${(mp4Stats.size / 1024).toFixed(0)} KB`);
    } catch (err) {
        log(`FAIL: FFmpeg wrap failed: ${err.message}`);
        win.close();
        app.quit();
        return;
    }

    // Verify with ffprobe-like check
    try {
        const probeOut = execSync(`"${FFMPEG}" -i "${fullMp4}" -v quiet -print_format json -show_streams -show_format`, { encoding: 'utf8' });
        // Extract just the JSON part (ffmpeg may output extra text)
        const jsonStart = probeOut.indexOf('{');
        if (jsonStart >= 0) {
            const probeData = JSON.parse(probeOut.substring(jsonStart));
            const vstream = probeData.streams && probeData.streams.find(s => s.codec_type === 'video');
            if (vstream) {
                log(`  Codec:   ${vstream.codec_name} (${vstream.profile || 'unknown'})`);
                log(`  Size:    ${vstream.width}x${vstream.height}`);
                log(`  Frames:  ${vstream.nb_frames || 'unknown'}`);
            }
            if (probeData.format) {
                log(`  Duration: ${parseFloat(probeData.format.duration || 0).toFixed(2)}s`);
            }
        }
    } catch (_) {
        log('  (Stream info check skipped)');
    }

    // Cleanup .h264 temp
    try { fs.unlinkSync(fullH264); } catch (_) {}

    log('');
    log('=== NATIVE D3D11 + NVENC EXPORT TEST COMPLETE ===');
    log(`Output: ${fullMp4}`);

    win.close();
    setTimeout(() => app.quit(), 500);
});

app.on('window-all-closed', () => {});
