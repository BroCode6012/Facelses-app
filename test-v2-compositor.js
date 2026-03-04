/**
 * test-v2-compositor.js — Prove whether renderer-process WebGL rendering
 * goes into shared D3D11 textures when v2BeginFrame/v2EndFrame are called.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron ./test-v2-compositor.js
 *
 * Test has TWO phases:
 *   Phase A: Native GL render (main thread) → D3D readback (KNOWN WORKING — control)
 *   Phase B: Renderer WebGL render (GPU thread) → D3D readback (THE QUESTION)
 *
 * For Phase B, renderer clears canvas to a different color each frame,
 * and we compare:
 *   - WebGL readPixels (what the renderer actually drew)
 *   - D3D11 readback (what's in the shared texture)
 * If they match: rendering goes into shared texture (ideal!)
 * If D3D11 shows zeros/stale: separate contexts, need fix.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');

const addon = require('./src/native/gpu-export/build/Release/gpu_export.node');

const W = 1920, H = 1080, COUNT = 3, FRAMES = 10;

function log(msg) { console.log(`[V2-COMP] ${msg}`); }

app.whenReady().then(async () => {
    log('=== V2 Compositor Rendering Test ===');
    log('');

    // -- Probe --
    const probe = addon.probeAngleD3D11();
    if (!probe.ok) { log(`FAIL: Probe: ${probe.reason}`); app.quit(); return; }
    log(`GPU: ${probe.details.adapterDescription}`);

    // -- Create BrowserWindow --
    const win = new BrowserWindow({
        width: W, height: H, show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    // IPC handlers for the renderer test
    ipcMain.handle('v2t-create', async () => {
        const t = addon.createSharedTextures(W, H, COUNT);
        if (!t.ok) return { ok: false, error: 'createSharedTextures failed' };
        const p = addon.createPbufferSurfaces(COUNT);
        if (!p.ok) { addon.destroySharedTextures(); return { ok: false, error: 'createPbufferSurfaces failed' }; }
        return { ok: true };
    });

    ipcMain.handle('v2t-begin', async (e, idx) => addon.makePbufferCurrent(idx));
    ipcMain.handle('v2t-end', async (e, idx) => addon.restoreDefaultSurface());

    ipcMain.handle('v2t-readback', async (e, idx) => {
        const buf = addon.readTextureToBuffer(idx);
        if (!buf) return { ok: false };
        // Read center pixel and a few samples
        const cx = Math.floor(W / 2), cy = Math.floor(H / 2);
        const off = (cy * W + cx) * 4;
        // Also check a few other pixels to detect non-uniform content
        const corner = 0; // top-left
        const mid2 = (Math.floor(H / 4) * W + Math.floor(W / 4)) * 4;
        return {
            ok: true,
            center: { b: buf[off], g: buf[off+1], r: buf[off+2], a: buf[off+3] },
            corner: { b: buf[corner], g: buf[corner+1], r: buf[corner+2], a: buf[corner+3] },
            quarter: { b: buf[mid2], g: buf[mid2+1], r: buf[mid2+2], a: buf[mid2+3] },
        };
    });

    // Phase A: native GL control
    ipcMain.handle('v2t-native-render', async (e, { idx, r, g, b }) => {
        addon.makePbufferCurrent(idx);
        addon.renderSolidColor(r, g, b, 1.0);
        addon.restoreDefaultSurface();
        const buf = addon.readTextureToBuffer(idx);
        const cx = Math.floor(W / 2), cy = Math.floor(H / 2);
        const off = (cy * W + cx) * 4;
        return { b: buf[off], g: buf[off+1], r: buf[off+2], a: buf[off+3] };
    });

    ipcMain.handle('v2t-cleanup', async () => {
        addon.destroyPbufferSurfaces();
        addon.destroySharedTextures();
    });

    // Inline renderer HTML
    const html = `<!DOCTYPE html><html><body>
<canvas id="c" width="${W}" height="${H}" style="display:none"></canvas>
<script>
const { ipcRenderer } = require('electron');

async function run() {
    const canvas = document.getElementById('c');
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
    if (!gl) { console.error('No WebGL2'); ipcRenderer.send('done', { error: 'No WebGL2' }); return; }
    console.log('[Renderer] WebGL2 renderer:', gl.getParameter(gl.RENDERER));

    // Create targets
    const cr = await ipcRenderer.invoke('v2t-create');
    if (!cr.ok) { console.error('Create failed:', cr.error); ipcRenderer.send('done', { error: cr.error }); return; }

    const results = { phaseA: [], phaseB: [] };

    // ========== PHASE A: Native GL control ==========
    console.log('');
    console.log('=== PHASE A: Native GL Render (control) ===');
    for (let i = 0; i < 5; i++) {
        const r = i * 0.2, g = 1.0 - i * 0.2, b = 0.5;
        const px = await ipcRenderer.invoke('v2t-native-render', { idx: i % 3, r, g, b });
        const expected = { r: Math.round(r*255), g: Math.round(g*255), b: Math.round(b*255) };
        const match = Math.abs(px.r - expected.r) < 3 && Math.abs(px.g - expected.g) < 3 && Math.abs(px.b - expected.b) < 3;
        console.log('  Frame ' + i + ': D3D BGRA=(' + px.b + ',' + px.g + ',' + px.r + ',' + px.a + ') expected~=(' + expected.b + ',' + expected.g + ',' + expected.r + ',255) ' + (match ? 'OK' : 'MISMATCH'));
        results.phaseA.push({ frame: i, d3d: px, expected, match });
    }

    // ========== PHASE B: Renderer WebGL render ==========
    console.log('');
    console.log('=== PHASE B: Renderer WebGL Render (the question) ===');
    for (let i = 0; i < ${FRAMES}; i++) {
        const targetIdx = i % 3;
        const r = i / ${FRAMES};
        const g = 1.0 - i / ${FRAMES};
        const b = 0.3 + (i % 3) * 0.2;

        // Switch main-thread EGL to pbuffer
        await ipcRenderer.invoke('v2t-begin', targetIdx);

        // WebGL render in renderer process
        gl.clearColor(r, g, b, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.flush();
        gl.finish();

        // Restore main-thread EGL
        await ipcRenderer.invoke('v2t-end', targetIdx);

        // Read what WebGL actually rendered (ground truth)
        const webglPx = new Uint8Array(4);
        gl.readPixels(${Math.floor(W/2)}, ${Math.floor(H/2)}, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, webglPx);

        // D3D11 readback from shared texture
        const d3d = await ipcRenderer.invoke('v2t-readback', targetIdx);

        const webgl = { r: webglPx[0], g: webglPx[1], b: webglPx[2], a: webglPx[3] };
        let match = false;
        if (d3d.ok) {
            match = Math.abs(d3d.center.r - webgl.r) < 3
                 && Math.abs(d3d.center.g - webgl.g) < 3
                 && Math.abs(d3d.center.b - webgl.b) < 3;
        }

        const d3dStr = d3d.ok ? 'BGRA=(' + d3d.center.b + ',' + d3d.center.g + ',' + d3d.center.r + ',' + d3d.center.a + ')' : 'FAILED';
        console.log('  Frame ' + i + ': WebGL RGBA=(' + webgl.r + ',' + webgl.g + ',' + webgl.b + ',' + webgl.a + ') D3D ' + d3dStr + ' ' + (match ? 'MATCH' : 'NO MATCH'));

        results.phaseB.push({ frame: i, webgl, d3d: d3d.ok ? d3d.center : null, match });
    }

    // Summary
    console.log('');
    const phaseAOk = results.phaseA.every(r => r.match);
    const phaseBOk = results.phaseB.every(r => r.match);
    const phaseBAllZero = results.phaseB.every(r => r.d3d && r.d3d.r === 0 && r.d3d.g === 0 && r.d3d.b === 0);
    const phaseBChanging = new Set(results.phaseB.map(r => r.d3d ? r.d3d.r + ',' + r.d3d.g + ',' + r.d3d.b : '')).size > 1;

    console.log('=== RESULTS ===');
    console.log('Phase A (native GL → D3D readback): ' + (phaseAOk ? 'ALL MATCH' : 'SOME MISMATCH'));
    console.log('Phase B (renderer WebGL → D3D readback): ' + (phaseBOk ? 'ALL MATCH — rendering goes to shared texture!' : 'NO MATCH'));
    if (!phaseBOk) {
        console.log('  D3D all zeros: ' + phaseBAllZero);
        console.log('  D3D pixels changing between frames: ' + phaseBChanging);
        if (phaseBAllZero) {
            console.log('  DIAGNOSIS: Shared textures are empty — renderer WebGL does NOT write to pbuffer.');
            console.log('  FIX: Need to move EGL binding to renderer-process/GPU-thread context.');
        } else if (!phaseBChanging) {
            console.log('  DIAGNOSIS: D3D has stale data (from Phase A native GL). Renderer does not affect shared texture.');
            console.log('  FIX: Need to move EGL binding to renderer-process/GPU-thread context.');
        } else {
            console.log('  DIAGNOSIS: D3D pixels are changing but not matching WebGL. Partial redirect or timing issue.');
        }
    }

    // ========== PHASE C: Load addon IN RENDERER, call makePbufferCurrent from renderer JS ==========
    console.log('');
    console.log('=== PHASE C: Renderer-side addon (same process as WebGL) ===');
    results.phaseC = [];
    try {
        const raddon = require('./src/native/gpu-export/build/Release/gpu_export.node');
        console.log('  Addon loaded in renderer process');

        // Create fresh targets in renderer-side addon
        const rprobe = raddon.probeAngleD3D11();
        if (!rprobe.ok) throw new Error('Probe failed in renderer: ' + rprobe.reason);
        console.log('  Renderer-side D3D device: ' + rprobe.details.adapterDescription);

        const rtex = raddon.createSharedTextures(${W}, ${H}, 3);
        if (!rtex.ok) throw new Error('createSharedTextures failed in renderer');
        const rpbuf = raddon.createPbufferSurfaces(3);
        if (!rpbuf.ok) throw new Error('createPbufferSurfaces failed in renderer');
        console.log('  Renderer-side targets created');

        for (let i = 0; i < 5; i++) {
            const targetIdx = i % 3;
            const r = i * 0.2, g = 0.0, b = 1.0 - i * 0.2;

            // Make pbuffer current from renderer JS thread
            raddon.makePbufferCurrent(targetIdx);

            // WebGL render (goes through command buffer → GPU thread)
            gl.clearColor(r, g, b, 1.0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.flush();
            gl.finish();

            raddon.restoreDefaultSurface();

            // WebGL readPixels (ground truth)
            const webglPx = new Uint8Array(4);
            gl.readPixels(${Math.floor(W/2)}, ${Math.floor(H/2)}, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, webglPx);

            // D3D readback from renderer-side addon
            const buf = raddon.readTextureToBuffer(targetIdx);
            const off = (${Math.floor(H/2)} * ${W} + ${Math.floor(W/2)}) * 4;
            const d3d = buf ? { b: buf[off], g: buf[off+1], r: buf[off+2], a: buf[off+3] } : null;

            const webgl = { r: webglPx[0], g: webglPx[1], b: webglPx[2], a: webglPx[3] };
            let match = false;
            if (d3d) {
                match = Math.abs(d3d.r - webgl.r) < 3 && Math.abs(d3d.g - webgl.g) < 3 && Math.abs(d3d.b - webgl.b) < 3;
            }
            const d3dStr = d3d ? 'BGRA=(' + d3d.b + ',' + d3d.g + ',' + d3d.r + ',' + d3d.a + ')' : 'null';
            console.log('  Frame ' + i + ': WebGL RGBA=(' + webgl.r + ',' + webgl.g + ',' + webgl.b + ',' + webgl.a + ') D3D ' + d3dStr + ' ' + (match ? 'MATCH' : 'NO MATCH'));
            results.phaseC.push({ frame: i, webgl, d3d, match });
        }

        // Cleanup renderer-side targets
        raddon.destroyPbufferSurfaces();
        raddon.destroySharedTextures();

        const phaseCOk = results.phaseC.every(r => r.match);
        console.log('Phase C result: ' + (phaseCOk ? 'ALL MATCH — renderer-side EGL works!' : 'NO MATCH — GPU thread is separate'));
    } catch (e) {
        console.log('  Phase C error: ' + e.message);
    }

    await ipcRenderer.invoke('v2t-cleanup');
    ipcRenderer.send('done', results);
}

run().catch(e => { console.error(e.message); ipcRenderer.send('done', { error: e.message }); });
</script></body></html>`;

    // Forward renderer console to main stdout
    win.webContents.on('console-message', (e, level, msg) => {
        console.log(msg);
    });

    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    ipcMain.once('done', (e, results) => {
        log('');
        log('Test complete.');
        win.close();
        setTimeout(() => app.quit(), 500);
    });
});

app.on('window-all-closed', () => {});
