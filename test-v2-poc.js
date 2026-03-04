/**
 * test-v2-poc.js — Phase 2 POC: shared textures + EGL pbuffers
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron ./test-v2-poc
 *
 * Tests:
 * 1. Create BrowserWindow with WebGL (initializes ANGLE/EGL)
 * 2. Create 3 shared D3D11 textures (1920x1080, BGRA)
 * 3. Create 3 EGL pbuffer surfaces from share handles
 * 4. For each pbuffer: makeCurrent → render solid color → flush
 * 5. Read back each texture via D3D11 Map and verify pixel color
 * 6. Restore original EGL surface
 * 7. Cleanup
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

// GPU flags — required for EGL access from main process
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');

const addon = require('./src/native/gpu-export/build/Release/gpu_export.node');

const WIDTH = 1920;
const HEIGHT = 1080;
const TEX_COUNT = 3;

// Colors to render: red, green, blue (BGRA byte order)
const TEST_COLORS = [
    { name: 'RED',   bgra: [0, 0, 255, 255] },
    { name: 'GREEN', bgra: [0, 255, 0, 255] },
    { name: 'BLUE',  bgra: [255, 0, 0, 255] },
];

function log(msg) {
    console.log(`[POC] ${msg}`);
}

function fail(msg) {
    console.error(`[POC] FAIL: ${msg}`);
    app.quit();
    process.exit(1);
}

app.whenReady().then(async () => {
    log('=== Phase 2 POC Test ===');
    log('');

    // --- Step 1: Probe ---
    log('Step 1: Probing ANGLE D3D11...');
    const probe = addon.probeAngleD3D11();
    if (!probe.ok) {
        fail(`Probe failed: ${probe.reason} — ${probe.error}`);
        return;
    }
    log(`  GPU: ${probe.details.adapterDescription}`);
    log(`  Sharing: ${probe.details.sharingMethod}`);
    log('');

    // --- Step 2: Create BrowserWindow with WebGL FIRST ---
    // This initializes ANGLE/EGL so we can get a valid display
    log('Step 2: Creating BrowserWindow with WebGL context...');
    const win = new BrowserWindow({
        width: WIDTH,
        height: HEIGHT,
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        }
    });

    const htmlContent = `
    <html><body>
    <canvas id="c" width="${WIDTH}" height="${HEIGHT}"></canvas>
    <script>
        const canvas = document.getElementById('c');
        const gl = canvas.getContext('webgl2', {
            alpha: false,
            preserveDrawingBuffer: true,
            powerPreference: 'high-performance'
        });
        if (!gl) {
            require('electron').ipcRenderer.send('poc-error', 'WebGL2 not available');
        } else {
            require('electron').ipcRenderer.send('poc-ready', {
                renderer: gl.getParameter(gl.RENDERER),
                vendor: gl.getParameter(gl.VENDOR),
            });
        }

        // Listen for render commands
        require('electron').ipcRenderer.on('poc-render', (event, color) => {
            gl.clearColor(color[0], color[1], color[2], color[3]);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.flush();
            gl.finish();
            require('electron').ipcRenderer.send('poc-rendered');
        });
    </script>
    </body></html>`;

    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);

    // Wait for WebGL ready
    const glInfo = await new Promise((resolve, reject) => {
        ipcMain.once('poc-ready', (event, info) => resolve(info));
        ipcMain.once('poc-error', (event, err) => reject(new Error(err)));
        setTimeout(() => reject(new Error('Timeout waiting for WebGL')), 10000);
    });

    log(`  WebGL renderer: ${glInfo.renderer}`);
    log(`  WebGL vendor: ${glInfo.vendor}`);
    log('');

    // --- Step 3: Create shared textures (AFTER WebGL is ready) ---
    log(`Step 3: Creating ${TEX_COUNT} shared textures (${WIDTH}x${HEIGHT})...`);
    const texResult = addon.createSharedTextures(WIDTH, HEIGHT, TEX_COUNT);
    if (!texResult.ok) {
        fail('createSharedTextures failed');
        return;
    }
    log(`  Created ${texResult.count} textures`);
    for (let i = 0; i < texResult.count; i++) {
        log(`  Texture[${i}] shareHandle: ${texResult.shareHandles[i]}`);
    }
    log('');

    // --- Step 4: Create EGL pbuffer surfaces (AFTER ANGLE is initialized) ---
    log(`Step 4: Creating ${TEX_COUNT} EGL pbuffer surfaces from share handles...`);
    const pbufResult = addon.createPbufferSurfaces(TEX_COUNT);
    if (!pbufResult.ok) {
        fail('createPbufferSurfaces failed');
        return;
    }
    log(`  Created ${pbufResult.count} pbuffer surfaces`);
    log('');

    // --- Step 5: Render into each pbuffer via native GL ---
    log('Step 5: Rendering solid colors into pbuffers (native GL)...');

    for (let i = 0; i < TEX_COUNT; i++) {
        const color = TEST_COLORS[i];
        log(`  [${i}] Rendering ${color.name}...`);

        // Switch to pbuffer
        const mkOk = addon.makePbufferCurrent(i);
        if (!mkOk) {
            fail(`makePbufferCurrent(${i}) failed`);
            return;
        }

        // Render solid color using native GL (glClearColor + glClear + glFinish)
        // Pass as normalized RGBA (not BGRA)
        const ok = addon.renderSolidColor(
            color.bgra[2] / 255,  // R
            color.bgra[1] / 255,  // G
            color.bgra[0] / 255,  // B
            color.bgra[3] / 255   // A
        );
        if (!ok) {
            fail(`renderSolidColor(${color.name}) failed`);
            return;
        }
        log(`    Rendered ${color.name} OK`);
    }
    log('');

    // --- Step 6: Restore original surface ---
    log('Step 6: Restoring original EGL surface...');
    const restoreOk = addon.restoreDefaultSurface();
    if (!restoreOk) {
        log('  WARNING: restoreDefaultSurface failed (may be expected in headless)');
    } else {
        log('  Restored');
    }
    log('');

    // --- Step 7: Read back and verify ---
    log('Step 7: D3D11 readback + verification...');

    let allPassed = true;
    for (let i = 0; i < TEX_COUNT; i++) {
        const color = TEST_COLORS[i];

        // Read texture to buffer
        const buf = addon.readTextureToBuffer(i);
        if (!buf) {
            log(`  [${i}] FAIL: readTextureToBuffer returned null`);
            allPassed = false;
            continue;
        }

        // Check center pixel (BGRA order in buffer)
        const centerOffset = (Math.floor(HEIGHT / 2) * WIDTH + Math.floor(WIDTH / 2)) * 4;
        const b = buf[centerOffset];
        const g = buf[centerOffset + 1];
        const r = buf[centerOffset + 2];
        const a = buf[centerOffset + 3];

        const expectedB = color.bgra[0];
        const expectedG = color.bgra[1];
        const expectedR = color.bgra[2];

        const tolerance = 5;
        const bOk = Math.abs(b - expectedB) <= tolerance;
        const gOk = Math.abs(g - expectedG) <= tolerance;
        const rOk = Math.abs(r - expectedR) <= tolerance;

        if (bOk && gOk && rOk) {
            log(`  [${i}] ${color.name}: PASS (BGRA=${b},${g},${r},${a})`);
        } else {
            log(`  [${i}] ${color.name}: FAIL (got BGRA=${b},${g},${r},${a}, expected ~${expectedB},${expectedG},${expectedR},255)`);
            allPassed = false;
        }
    }
    log('');

    // --- Cleanup ---
    log('Cleanup...');
    addon.destroyPbufferSurfaces();
    addon.destroySharedTextures();
    win.close();

    log('');
    if (allPassed) {
        log('=== ALL TESTS PASSED ===');
    } else {
        log('=== SOME TESTS FAILED ===');
    }

    app.quit();
});

app.on('window-all-closed', () => {});
