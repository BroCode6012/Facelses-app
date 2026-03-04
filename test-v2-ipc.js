/**
 * test-v2-ipc.js — Test V2 IPC pipeline end-to-end
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron ./test-v2-poc
 *   (with main pointing to ../test-v2-ipc.js in test-v2-poc/package.json)
 *
 * OR directly: set ELECTRON_RUN_AS_NODE= && npx electron ./test-v2-ipc.js
 *
 * Tests the full V2 pipeline:
 *   1. Probe ANGLE D3D11
 *   2. Create BrowserWindow with WebGL
 *   3. Create shared targets (textures + pbuffers)
 *   4. Init encoder (spawn FFmpeg with BGRA input)
 *   5. Render 60 frames via native GL into pbuffers
 *   6. D3D11 readback → FFmpeg stdin for each frame
 *   7. Flush encoder → produce MP4
 *   8. Cleanup
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// GPU flags
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');

const addon = require('./src/native/gpu-export/build/Release/gpu_export.node');

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const TOTAL_FRAMES = 60;
const TARGET_COUNT = 3;

function log(msg) { console.log(`[V2-IPC] ${msg}`); }

app.whenReady().then(async () => {
    log('=== V2 IPC Pipeline Test ===');
    log('');

    // 1. Probe
    log('Step 1: Probing ANGLE D3D11...');
    const probe = addon.probeAngleD3D11();
    if (!probe.ok) {
        log(`FAIL: Probe failed: ${probe.reason}`);
        app.quit(); return;
    }
    log(`  GPU: ${probe.details.adapterDescription}`);
    log('');

    // 2. Create BrowserWindow (initializes ANGLE/EGL)
    log('Step 2: Creating BrowserWindow with WebGL...');
    const win = new BrowserWindow({
        width: WIDTH, height: HEIGHT, show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    const html = `<html><body><canvas id="c" width="${WIDTH}" height="${HEIGHT}"></canvas>
    <script>
        const gl = document.getElementById('c').getContext('webgl2', { preserveDrawingBuffer: true });
        if (!gl) require('electron').ipcRenderer.send('ready', null);
        else require('electron').ipcRenderer.send('ready', { renderer: gl.getParameter(gl.RENDERER) });
    </script></body></html>`;
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    const glInfo = await new Promise((resolve, reject) => {
        ipcMain.once('ready', (e, info) => info ? resolve(info) : reject(new Error('WebGL2 not available')));
        setTimeout(() => reject(new Error('Timeout')), 10000);
    });
    log(`  WebGL: ${glInfo.renderer}`);
    log('');

    // 3. Create shared targets
    log(`Step 3: Creating ${TARGET_COUNT} targets (${WIDTH}x${HEIGHT})...`);
    const texResult = addon.createSharedTextures(WIDTH, HEIGHT, TARGET_COUNT);
    if (!texResult.ok) { log('FAIL: createSharedTextures'); app.quit(); return; }
    const pbufResult = addon.createPbufferSurfaces(TARGET_COUNT);
    if (!pbufResult.ok) { log('FAIL: createPbufferSurfaces'); app.quit(); return; }
    log(`  Created ${TARGET_COUNT} targets`);
    log('');

    // 4. Spawn FFmpeg with BGRA input
    log('Step 4: Spawning FFmpeg (BGRA rawvideo → h264)...');
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const outputFile = path.join(outputDir, 'test-v2-ipc.mp4');
    const FFMPEG = process.env.FFMPEG_PATH || 'C:\\ffmg\\bin\\ffmpeg.exe';

    const { spawn } = require('child_process');
    const ffmpeg = spawn(FFMPEG, [
        '-y', '-f', 'rawvideo', '-pixel_format', 'bgra',
        '-video_size', `${WIDTH}x${HEIGHT}`, '-framerate', String(FPS),
        '-i', 'pipe:0',
        '-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '18M',
        '-pix_fmt', 'yuv420p', '-an', outputFile
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let ffmpegErr = '';
    ffmpeg.stderr.on('data', d => { ffmpegErr += d.toString(); });
    log(`  FFmpeg PID: ${ffmpeg.pid}`);
    log('');

    // 5+6. Frame loop: render → readback → write to FFmpeg
    log(`Step 5: Rendering ${TOTAL_FRAMES} frames...`);
    const startTime = Date.now();
    let framesWritten = 0;

    for (let frame = 0; frame < TOTAL_FRAMES; frame++) {
        const targetIdx = frame % TARGET_COUNT;

        // Animate color: cycle hue across frames
        const t = frame / TOTAL_FRAMES;
        const r = Math.sin(t * Math.PI * 2) * 0.5 + 0.5;
        const g = Math.sin(t * Math.PI * 2 + 2.094) * 0.5 + 0.5;
        const b = Math.sin(t * Math.PI * 2 + 4.189) * 0.5 + 0.5;

        // Switch to pbuffer
        addon.makePbufferCurrent(targetIdx);

        // Render solid color via native GL
        addon.renderSolidColor(r, g, b, 1.0);

        // Restore default surface
        addon.restoreDefaultSurface();

        // D3D11 readback
        const buf = addon.readTextureToBuffer(targetIdx);
        if (!buf) {
            log(`FAIL: readTextureToBuffer(${targetIdx}) returned null at frame ${frame}`);
            break;
        }

        // Debug first 3 frames
        if (frame < 3) {
            const cx = Math.floor(WIDTH / 2), cy = Math.floor(HEIGHT / 2);
            const off = (cy * WIDTH + cx) * 4;
            log(`  Frame ${frame} target[${targetIdx}] center BGRA=(${buf[off]},${buf[off+1]},${buf[off+2]},${buf[off+3]})`);
        }

        // Write to FFmpeg stdin
        const canWrite = ffmpeg.stdin.write(buf);
        if (!canWrite) {
            await new Promise(resolve => ffmpeg.stdin.once('drain', resolve));
        }
        framesWritten++;
    }

    const elapsed = (Date.now() - startTime) / 1000;
    log(`  Rendered ${framesWritten} frames in ${elapsed.toFixed(2)}s (${(framesWritten / elapsed).toFixed(1)} fps)`);
    log('');

    // 7. Close FFmpeg
    log('Step 6: Closing FFmpeg...');
    ffmpeg.stdin.end();

    const exitCode = await new Promise(resolve => {
        ffmpeg.on('close', code => resolve(code));
        setTimeout(() => { ffmpeg.kill(); resolve(-1); }, 30000);
    });

    if (exitCode !== 0) {
        log(`FAIL: FFmpeg exited with code ${exitCode}`);
        log(ffmpegErr.slice(-500));
    } else {
        const stats = fs.statSync(outputFile);
        log(`  Output: ${outputFile}`);
        log(`  Size: ${(stats.size / 1024).toFixed(0)} KB`);
        log('');
        log('=== V2 IPC PIPELINE TEST PASSED ===');
    }

    // 8. Cleanup
    addon.destroyPbufferSurfaces();
    addon.destroySharedTextures();
    win.close();
    app.quit();
});

app.on('window-all-closed', () => {});
