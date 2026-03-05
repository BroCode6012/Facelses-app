const { app } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(() => {
    const addon = require('./src/native/native-exporter/build/Release/native_exporter.node');
    const r = addon.composeAndEncode({
        width: 1920, height: 1080, fps: 30, totalFrames: 60,
        outputPath: path.join(__dirname, 'temp', 'fast-test.h264'),
        bitrate: 18000000, maxBitrate: 24000000, gop: 60,
        speedPreset: 'fast',
        layers: [
            { type: 'solid', color: [0, 0, 0, 1], startFrame: 0, endFrame: 60 },
            {
                type: 'video', mediaPath: path.join(__dirname, 'temp', 'scene-0.mp4'),
                startFrame: 0, endFrame: 60, fitMode: 'cover', opacity: 1.0,
                scaleX: 1, scaleY: 1, translateX: 0, translateY: 0,
                rotationRad: 0, anchorX: 0.5, anchorY: 0.5
            }
        ]
    });
    console.log('[FAST] ' + r.frames + ' frames in ' + r.elapsed.toFixed(2) + 's (' + r.fps.toFixed(1) + ' fps) ok=' + r.ok);
    try { fs.unlinkSync(path.join(__dirname, 'temp', 'fast-test.h264')); } catch (_) { }
    app.quit();
});
