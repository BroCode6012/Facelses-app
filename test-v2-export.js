/**
 * test-v2-export.js — Test V2 export with real compositor rendering (60 frames)
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron ./test-v2-export.js
 *
 * Creates a hidden BrowserWindow, loads a minimal compositor with a
 * procedural scene (color cycling), renders 60 frames via the V2 pipeline
 * (readPixels → v2EncodeFrame → FFmpeg NVENC → MP4).
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// GPU flags (same as main app)
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');

const W = 1920, H = 1080, FPS = 30, TOTAL_FRAMES = 60;
const FFMPEG = process.env.FFMPEG_PATH || 'C:\\ffmg\\bin\\ffmpeg.exe';
const OUTPUT_DIR = path.join(__dirname, 'output');
const TEMP_DIR = path.join(__dirname, 'temp');

function log(msg) { console.log(`[V2-EXP] ${msg}`); }

// V2 encoder state
let _export = null;

// IPC: init encoder
ipcMain.handle('v2-test-init', async (event, opts) => {
    const { width, height, fps, totalFrames } = opts;
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const videoFile = path.join(TEMP_DIR, `v2-test-${ts}.mp4`);
    const outputFile = path.join(OUTPUT_DIR, `v2-test-${ts}.mp4`);

    const proc = spawn(FFMPEG, [
        '-y', '-f', 'rawvideo', '-pixel_format', 'rgba',
        '-video_size', `${width}x${height}`, '-framerate', String(fps),
        '-i', 'pipe:0',
        '-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '18M',
        '-pix_fmt', 'yuv420p', '-an', videoFile
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    _export = { proc, videoFile, outputFile, width, height, framesWritten: 0, bytesWritten: 0, stderr };
    log(`FFmpeg PID: ${proc.pid} → ${videoFile}`);
    return { ok: true, videoFile };
});

// IPC: encode frame (raw RGBA buffer from renderer)
ipcMain.handle('v2-test-encode', async (event, opts) => {
    const exp = _export;
    if (!exp || !exp.proc || exp.proc.killed) return { ok: false, error: 'No FFmpeg' };

    const buf = Buffer.from(opts.frameBuffer);

    if (exp.framesWritten < 3) {
        const cx = Math.floor(exp.width / 2), cy = Math.floor(H / 2);
        const off = (cy * exp.width + cx) * 4;
        log(`Frame ${opts.frameIndex} center RGBA=(${buf[off]},${buf[off+1]},${buf[off+2]},${buf[off+3]})`);
    }

    const canWrite = exp.proc.stdin.write(buf);
    exp.framesWritten++;
    exp.bytesWritten += buf.length;
    if (!canWrite) await new Promise(resolve => exp.proc.stdin.once('drain', resolve));

    return { ok: true };
});

// IPC: flush (close FFmpeg)
ipcMain.handle('v2-test-flush', async () => {
    const exp = _export;
    if (!exp || !exp.proc) return { ok: false };

    exp.proc.stdin.end();
    const code = await new Promise(resolve => {
        exp.proc.on('close', c => resolve(c));
        setTimeout(() => { try { exp.proc.kill(); } catch(_){} resolve(-1); }, 30000);
    });

    if (code !== 0) {
        log(`FFmpeg exit ${code}: ${exp.stderr.slice(-300)}`);
        return { ok: false, error: `FFmpeg exit ${code}` };
    }

    // Copy to output
    fs.copyFileSync(exp.videoFile, exp.outputFile);
    const stats = fs.statSync(exp.outputFile);
    log(`Output: ${exp.outputFile} (${(stats.size / 1024).toFixed(0)} KB, ${exp.framesWritten} frames)`);

    _export = null;
    return { ok: true, outputPath: exp.outputFile, size: stats.size };
});

app.whenReady().then(async () => {
    log('=== V2 Compositor Export Test ===');

    const win = new BrowserWindow({
        width: W, height: H, show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    win.webContents.on('console-message', (e, level, msg) => {
        console.log(msg);
    });

    // Inline renderer: minimal WebGL2 compositor that renders color-cycling frames
    const html = `<!DOCTYPE html><html><body>
<canvas id="c" width="${W}" height="${H}"></canvas>
<script>
const { ipcRenderer } = require('electron');

async function run() {
    const canvas = document.getElementById('c');
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
    if (!gl) { ipcRenderer.send('done', { error: 'No WebGL2' }); return; }

    console.log('[Renderer] WebGL2: ' + gl.getParameter(gl.RENDERER));
    console.log('[Renderer] Canvas: ' + canvas.width + 'x' + canvas.height);

    // Simple shader: renders a gradient quad with per-frame color shift
    const vs = \`#version 300 es
    in vec2 a_pos;
    out vec2 v_uv;
    void main() {
        v_uv = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
    }\`;

    const fs = \`#version 300 es
    precision mediump float;
    in vec2 v_uv;
    uniform float u_time;
    out vec4 fragColor;
    void main() {
        float r = sin(v_uv.x * 3.14159 + u_time) * 0.5 + 0.5;
        float g = sin(v_uv.y * 3.14159 + u_time * 1.5) * 0.5 + 0.5;
        float b = sin((v_uv.x + v_uv.y) * 3.14159 + u_time * 0.7) * 0.5 + 0.5;
        fragColor = vec4(r, g, b, 1.0);
    }\`;

    function compileShader(type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error(gl.getShaderInfoLog(s));
            return null;
        }
        return s;
    }

    const prog = gl.createProgram();
    gl.attachShader(prog, compileShader(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compileShader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const posLoc = gl.getAttribLocation(prog, 'a_pos');
    const timeLoc = gl.getUniformLocation(prog, 'u_time');

    // Fullscreen quad
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Init encoder
    const init = await ipcRenderer.invoke('v2-test-init', {
        width: ${W}, height: ${H}, fps: ${FPS}, totalFrames: ${TOTAL_FRAMES}
    });
    if (!init.ok) { ipcRenderer.send('done', { error: 'init failed' }); return; }

    // Pixel buffer for readPixels
    const frameBytes = ${W} * ${H} * 4;
    const pixelBuf = new Uint8Array(frameBytes);

    console.log('[Renderer] Starting render loop: ' + ${TOTAL_FRAMES} + ' frames');
    const startTime = performance.now();

    for (let frame = 0; frame < ${TOTAL_FRAMES}; frame++) {
        const t = (frame / ${TOTAL_FRAMES}) * Math.PI * 4;

        // Render gradient with time-varying colors
        gl.viewport(0, 0, ${W}, ${H});
        gl.uniform1f(timeLoc, t);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.finish();

        // readPixels
        gl.readPixels(0, 0, ${W}, ${H}, gl.RGBA, gl.UNSIGNED_BYTE, pixelBuf);

        // Send to main → FFmpeg
        const enc = await ipcRenderer.invoke('v2-test-encode', {
            frameBuffer: pixelBuf.buffer,
            frameIndex: frame,
        });
        if (!enc.ok) {
            console.error('Encode failed at frame ' + frame);
            break;
        }

        if (frame % 10 === 0 || frame === ${TOTAL_FRAMES} - 1) {
            const elapsed = (performance.now() - startTime) / 1000;
            const fps = ((frame + 1) / elapsed).toFixed(1);
            console.log('[Renderer] Frame ' + (frame + 1) + '/' + ${TOTAL_FRAMES} + ' (' + fps + ' fps)');
        }
    }

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
    const avgFps = (${TOTAL_FRAMES} / ((performance.now() - startTime) / 1000)).toFixed(1);
    console.log('[Renderer] Render complete: ' + elapsed + 's (' + avgFps + ' fps avg)');

    // Flush
    const flush = await ipcRenderer.invoke('v2-test-flush');
    if (flush.ok) {
        console.log('');
        console.log('=== V2 COMPOSITOR EXPORT TEST PASSED ===');
        console.log('Output: ' + flush.outputPath + ' (' + (flush.size / 1024).toFixed(0) + ' KB)');
    } else {
        console.error('Flush failed: ' + (flush.error || 'unknown'));
    }

    ipcRenderer.send('done');
}

run().catch(e => { console.error(e.message); ipcRenderer.send('done'); });
</script></body></html>`;

    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    ipcMain.once('done', () => {
        win.close();
        setTimeout(() => app.quit(), 500);
    });
});

app.on('window-all-closed', () => {});
