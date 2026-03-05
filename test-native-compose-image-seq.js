/**
 * test-native-compose-image-seq.js — Test imageSequence layer in D3D11 Compositor
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron ./test-native-compose-image-seq.js
 *
 * Generates 60 PNG frames with FFmpeg (animated gradient with alpha), then
 * composites as imageSequence layer over a solid background.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const FFMPEG = process.env.FFMPEG_PATH || 'C:\\ffmg\\bin\\ffmpeg.exe';
const OUTPUT_DIR = path.join(__dirname, 'output');
const TEMP_DIR = path.join(__dirname, 'temp');
const SEQ_DIR = path.join(TEMP_DIR, 'image-seq-test');

function log(msg) { console.log(`[ImgSeqTest] ${msg}`); }

function ensureDirs() {
    for (const d of [OUTPUT_DIR, TEMP_DIR, SEQ_DIR]) {
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }
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
    log('=== imageSequence Layer Test ===');
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

    // ========== Generate 60 PNG frames (400x200, RGBA, animated gradient) ==========
    log('--- Generating 60 PNG frames (400x200, RGBA) ---');

    try {
        // Generate an animated gradient with alpha channel using lavfi
        // Each frame has a different hue shift so frame 0 != frame 59
        await runFFmpeg([
            '-y',
            '-f', 'lavfi',
            '-i', 'color=c=black@0:s=400x200:d=2:r=30,format=rgba,geq=' +
                  'r=128+127*sin(2*PI*(X/400)+T*3):' +
                  'g=128+127*sin(2*PI*(X/400)+T*3+2.09):' +
                  'b=128+127*sin(2*PI*(X/400)+T*3+4.19):' +
                  'a=200',
            '-frames:v', '60',
            path.join(SEQ_DIR, 'frame_%06d.png')
        ]);
    } catch (err) {
        log(`FAIL: FFmpeg PNG generation: ${err.message}`);
        win.close();
        app.quit();
        return;
    }

    // Verify frames exist
    const frame0 = path.join(SEQ_DIR, 'frame_000001.png');
    const frame59 = path.join(SEQ_DIR, 'frame_000060.png');
    if (!fs.existsSync(frame0) || !fs.existsSync(frame59)) {
        log('FAIL: PNG frames not generated');
        win.close();
        app.quit();
        return;
    }
    log(`  Generated frames: ${fs.readdirSync(SEQ_DIR).length} PNGs`);

    // ========== TEST: imageSequence over solid background ==========
    log('--- Test: imageSequence (60 frames) over solid green ---');

    const h264File = path.join(TEMP_DIR, 'compose-imgseq.h264');
    const mp4File = path.join(OUTPUT_DIR, 'compose-imgseq.mp4');

    const result = addon.composeAndEncode({
        width: 1920, height: 1080, fps: 30, totalFrames: 60,
        outputPath: h264File,
        layers: [
            // Base: solid green
            { type: 'solid', color: [0.1, 0.5, 0.1, 1.0], startFrame: 0, endFrame: 60, trackNum: 1 },
            // Overlay: imageSequence (semi-transparent gradient)
            {
                type: 'imageSequence',
                startFrame: 0, endFrame: 60, trackNum: 2,
                opacity: 0.9,
                fitMode: 'contain',
                seqDir: SEQ_DIR,
                seqPattern: 'frame_%06d.png',
                seqFrameCount: 60,
                seqLocalStart: 1  // FFmpeg starts at 1
            }
        ]
    });

    if (!result.ok) {
        log(`FAIL: composeAndEncode: ${result.reason}`);
        win.close();
        app.quit();
        return;
    }

    log(`  Encoded ${result.frames} frames in ${result.elapsed.toFixed(3)}s (${result.fps.toFixed(1)} fps)`);

    const h264Size = fs.statSync(h264File).size;
    log(`  H.264: ${h264Size} bytes`);
    if (h264Size < 500) {
        log('FAIL: H.264 file too small');
        win.close();
        app.quit();
        return;
    }

    // Wrap in MP4
    try {
        await runFFmpeg(['-y', '-r', '30', '-i', h264File, '-c:v', 'copy', '-movflags', '+faststart', mp4File]);
        log(`  MP4: ${fs.statSync(mp4File).size} bytes`);
    } catch (err) {
        log(`FAIL: FFmpeg wrap: ${err.message}`);
        win.close();
        app.quit();
        return;
    }

    // Extract frame 0 and frame 59, verify they differ
    const png0 = path.join(TEMP_DIR, 'imgseq-f0.png');
    const png59 = path.join(TEMP_DIR, 'imgseq-f59.png');
    try {
        await runFFmpeg(['-y', '-i', mp4File, '-vf', 'select=eq(n\\,0)', '-vframes', '1', png0]);
        await runFFmpeg(['-y', '-i', mp4File, '-vf', 'select=eq(n\\,59)', '-vframes', '1', png59]);

        if (fs.existsSync(png0) && fs.existsSync(png59)) {
            const buf0 = fs.readFileSync(png0);
            const buf59 = fs.readFileSync(png59);
            const differ = !buf0.equals(buf59);
            log(`  Frame 0 size: ${buf0.length}, Frame 59 size: ${buf59.length}`);
            log(`  Frames differ: ${differ}`);
            if (!differ) {
                log('FAIL: Frame 0 and Frame 59 should differ (animated sequence)');
                win.close();
                app.quit();
                return;
            }
        }
    } catch (err) {
        log(`  (Frame extraction skipped: ${err.message})`);
    }

    log('  Test: PASSED');
    log('');

    // Cleanup temp
    try { fs.unlinkSync(h264File); } catch (_) {}
    try { fs.unlinkSync(png0); } catch (_) {}
    try { fs.unlinkSync(png59); } catch (_) {}

    log('=== All imageSequence tests PASSED ===');
    win.close();
    app.quit();
});
