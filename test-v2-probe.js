/**
 * Minimal Electron script to test V2 GPU probe with --in-process-gpu.
 * Run: npx electron test-v2-probe.js
 */
const { app } = require('electron');

// Must be set before app.whenReady()
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(() => {
    console.log('\n=== V2 GPU Probe Test ===\n');

    let addon;
    try {
        addon = require('./src/native/gpu-export/build/Release/gpu_export.node');
        console.log('[OK] Native addon loaded');
    } catch (e) {
        console.error('[FAIL] Could not load addon:', e.message);
        app.quit();
        return;
    }

    try {
        const result = addon.probeAngleD3D11();
        console.log('\nProbe result:');
        console.log(JSON.stringify(result, null, 2));

        if (result.ok) {
            console.log('\n=== SUCCESS ===');
            console.log('  ANGLE D3D11 backend: YES');
            console.log('  Renderer:', result.details?.renderer);
            console.log('  Adapter:', result.details?.adapterDescription);
            console.log('  LUID:', result.details?.adapterLuid);
            console.log('  EGL extensions:', result.details?.eglExtensions?.length);
        } else {
            console.log('\n=== FAILED ===');
            console.log('  Reason:', result.reason);
            console.log('  Error:', result.error);
        }
    } catch (e) {
        console.error('[FAIL] Probe threw:', e.message);
    }

    app.quit();
});

app.on('window-all-closed', () => app.quit());
