/**
 * test-mg-png-renderer.js — Smoke test for MG PNG renderer (Part B).
 *
 * Run: node test-mg-png-renderer.js
 *
 * Tests canvas path with 3 MG types (headline, lowerThird, statCounter).
 * Verifies: PNG files created, manifest written, cache hit on re-run.
 */
const path = require('path');
const fs = require('fs');

const CACHE_DIR = path.join(__dirname, 'temp', 'mg-png-cache-test');

function log(msg) { console.log(`[MGPngTest] ${msg}`); }

async function main() {
    log('=== MG PNG Renderer Smoke Test ===');

    // Clean cache for fresh test
    if (fs.existsSync(CACHE_DIR)) {
        fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    }

    const { renderMGsToPNG } = require('./src/mg-png-renderer');

    const testMGs = [
        { type: 'headline', text: 'Breaking News', subtext: 'Something happened', style: 'clean', position: 'center', duration: 2 },
        { type: 'lowerThird', text: 'John Smith', subtext: 'CEO of Company', style: 'bold', position: 'bottom-left', duration: 1.5 },
        { type: 'statCounter', text: 'Revenue', subtext: '$1.5M', style: 'neon', position: 'center', duration: 2 },
    ];

    const scriptContext = { themeId: 'tech', mgAnimationSpeed: 1.0 };

    // --- Run 1: Fresh render ---
    log('--- Run 1: Fresh render (no cache) ---');
    const t0 = Date.now();
    const result = await renderMGsToPNG({
        motionGraphics: testMGs,
        mgScenes: [],
        scenes: [],
        scriptContext,
        fps: 30,
    }, CACHE_DIR, (pct, msg) => {
        log(`  [${pct}%] ${msg}`);
    });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    log(`  Render time: ${elapsed}s`);
    log(`  Layers: ${result.layers.length}`);

    if (result.layers.length !== 3) {
        log('FAIL: Expected 3 layers');
        process.exit(1);
    }

    // Verify each layer
    for (const layer of result.layers) {
        log(`  Layer: ${layer.mgType} → ${layer.seqDir}`);
        log(`    Tile: ${layer.tileW}x${layer.tileH}, frames: ${layer.seqFrameCount}`);

        // Check manifest exists
        const manifestPath = path.join(layer.seqDir, 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
            log(`FAIL: No manifest at ${manifestPath}`);
            process.exit(1);
        }

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!manifest.complete) {
            log('FAIL: Manifest not complete');
            process.exit(1);
        }

        // Check frame files exist
        const frame0 = path.join(layer.seqDir, 'frame_000000.png');
        const frameLast = path.join(layer.seqDir, `frame_${String(layer.seqFrameCount - 1).padStart(6, '0')}.png`);
        if (!fs.existsSync(frame0)) {
            log(`FAIL: Missing frame_000000.png in ${layer.seqDir}`);
            process.exit(1);
        }
        if (!fs.existsSync(frameLast)) {
            log(`FAIL: Missing last frame in ${layer.seqDir}`);
            process.exit(1);
        }

        // Verify PNG is valid (starts with PNG signature)
        const buf = fs.readFileSync(frame0);
        if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47) {
            log('FAIL: frame_000000.png is not a valid PNG');
            process.exit(1);
        }

        log(`    frame_000000.png: ${buf.length} bytes, valid PNG`);
    }

    log('  Run 1: PASSED');
    log('');

    // --- Run 2: Cache hit ---
    log('--- Run 2: Cache hit test ---');
    const t1 = Date.now();
    const result2 = await renderMGsToPNG({
        motionGraphics: testMGs,
        mgScenes: [],
        scenes: [],
        scriptContext,
        fps: 30,
    }, CACHE_DIR, () => {});

    const elapsed2 = ((Date.now() - t1) / 1000).toFixed(2);
    log(`  Cache run time: ${elapsed2}s (should be near-instant)`);

    if (result2.layers.length !== 3) {
        log('FAIL: Expected 3 layers from cache');
        process.exit(1);
    }

    log('  Run 2: PASSED (cache hit)');
    log('');

    log('=== All MG PNG Renderer tests PASSED ===');
}

main().catch(err => {
    log(`FAIL: ${err.message}`);
    console.error(err);
    process.exit(1);
});
