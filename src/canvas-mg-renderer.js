'use strict';

/**
 * Canvas-based MG renderer — replaces Remotion for 14/16 MG types.
 * Uses @napi-rs/canvas (Google Skia) to draw frames, pipes raw RGBA to FFmpeg.
 * ~200fps vs ~5-10fps in Remotion (headless Chrome screenshots).
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { getStyle, makeShadow, parseKeyValuePairs, MG_BACKGROUNDS } = require('./mg-style-utils');

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmg\\bin\\ffmpeg.exe';
// Render at 2x resolution for supersampled anti-aliased text, then downscale in FFmpeg.
// Without this, canvas text edges look jagged compared to browser-rendered Remotion.
// We use ctx.scale(SUPERSAMPLE, SUPERSAMPLE) so all renderers work in logical 1920x1080
// coordinates — no need to multiply individual pixel values.
const SUPERSAMPLE = 2;
const S = SUPERSAMPLE;
const W = 1920;   // logical width  (renderers use this)
const H = 1080;   // logical height (renderers use this)
const PW = W * S; // physical width  (canvas buffer + FFmpeg use this)
const PH = H * S; // physical height (canvas buffer + FFmpeg use this)

// Canvas module (lazy loaded)
let _canvas = null;
function getCanvasModule() {
    if (!_canvas) _canvas = require('@napi-rs/canvas');
    return _canvas;
}

// ---------------------------------------------------------------------------
// ANIMATION UTILITIES (ported from Remotion)
// ---------------------------------------------------------------------------

// Core spring physics calculation — exact port of Remotion's springCalculation()
function springCalc(frame, fps, config) {
    const c = config.damping || 10;
    const m = config.mass || 1;
    const k = config.stiffness || 100;

    let current = 0;
    let velocity = 0;
    let lastTimestamp = 0;

    const frameClamped = Math.max(0, frame);
    const floorFrame = Math.floor(frameClamped);
    const unevenRest = frameClamped - floorFrame;

    for (let f = 0; f <= floorFrame; f++) {
        const actualF = (f === floorFrame) ? f + unevenRest : f;
        const now = (actualF / fps) * 1000;
        const deltaTime = Math.min(now - lastTimestamp, 64);
        const t = deltaTime / 1000;

        if (t <= 0) { lastTimestamp = now; continue; }

        const v0 = -velocity;
        const x0 = 1 - current;
        const zeta = c / (2 * Math.sqrt(k * m));
        const omega0 = Math.sqrt(k / m);

        if (zeta < 1) {
            const omega1 = omega0 * Math.sqrt(1 - zeta * zeta);
            const envelope = Math.exp(-zeta * omega0 * t);
            const sin1 = Math.sin(omega1 * t);
            const cos1 = Math.cos(omega1 * t);
            const frag1 = envelope * (sin1 * ((v0 + zeta * omega0 * x0) / omega1) + x0 * cos1);
            current = 1 - frag1;
            velocity = zeta * omega0 * frag1 -
                envelope * (cos1 * (v0 + zeta * omega0 * x0) - omega1 * x0 * sin1);
        } else {
            const envelope = Math.exp(-omega0 * t);
            current = 1 - envelope * (x0 + (v0 + omega0 * x0) * t);
            velocity = envelope * (v0 * (t * omega0 - 1) + t * x0 * omega0 * omega0);
        }

        lastTimestamp = now;
    }

    return current;
}

// Measure how many frames it takes for a spring to settle (within threshold).
// Exact port of Remotion's measureSpring().
function measureSpring(fps, config, threshold = 0.005) {
    let frame = 0;
    let finishedFrame = 0;
    let val = springCalc(frame, fps, config);
    let diff = Math.abs(val - 1);

    while (diff >= threshold) {
        frame++;
        val = springCalc(frame, fps, config);
        diff = Math.abs(val - 1);
    }

    finishedFrame = frame;
    for (let i = 0; i < 20; i++) {
        frame++;
        val = springCalc(frame, fps, config);
        diff = Math.abs(val - 1);
        if (diff >= threshold) {
            i = 0;
            finishedFrame = frame + 1;
        }
    }

    return finishedFrame;
}

// Main spring function — supports durationInFrames like Remotion's spring().
// When durationInFrames is set, the spring is time-stretched to fit exactly.
function springValue(frame, fps, config = {}) {
    const { durationInFrames, ...springConfig } = config;
    const cfg = { damping: 18, stiffness: 100, mass: 1, ...springConfig };

    let effectiveFrame = frame;
    if (durationInFrames !== undefined && durationInFrames > 0) {
        const naturalDuration = measureSpring(fps, cfg);
        if (naturalDuration > 0) {
            effectiveFrame = frame / (durationInFrames / naturalDuration);
        }
    }

    return springCalc(effectiveFrame, fps, cfg);
}

function interpolate(value, inputRange, outputRange, opts = {}) {
    const { extrapolateLeft = 'extend', extrapolateRight = 'extend' } = opts;
    // Multi-segment interpolation
    let idx = 0;
    for (let i = 1; i < inputRange.length; i++) {
        if (value <= inputRange[i]) { idx = i - 1; break; }
        idx = i - 1;
    }
    if (idx >= inputRange.length - 1) idx = inputRange.length - 2;
    const segStart = inputRange[idx];
    const segEnd = inputRange[idx + 1];
    let t = segEnd === segStart ? 1 : (value - segStart) / (segEnd - segStart);
    if (extrapolateLeft === 'clamp' && value < inputRange[0]) t = 0;
    if (extrapolateRight === 'clamp' && value > inputRange[inputRange.length - 1]) t = 1;
    if (extrapolateLeft === 'clamp') t = Math.max(0, t);
    if (extrapolateRight === 'clamp') t = Math.min(1, t);
    return outputRange[idx] + t * (outputRange[idx + 1] - outputRange[idx]);
}

function easeOutCubic(t) { return 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3); }

// animationSpeed: 1.0 = normal, <1 = slower/smoother, >1 = faster/snappier
// Passed via mg._animationSpeed (set from scriptContext.mgAnimationSpeed)
function computeAnimationState(frame, fps, mg) {
    const speed = mg._animationSpeed || 1.0;
    const totalFrames = Math.max(1, Math.round((mg.duration || 3) * fps));
    // Speed multiplier scales the enter/exit window: lower speed = longer enter/exit
    const enterFrames = Math.max(1, Math.min(Math.round((0.5 / speed) * fps), Math.round(totalFrames * 0.35)));
    const exitFrames  = Math.max(1, Math.min(Math.round((0.3 / speed) * fps), Math.round(totalFrames * 0.2)));

    const enterSpring = springValue(frame, fps, { damping: 18, stiffness: 100, durationInFrames: enterFrames });
    const enterLinear = clamp01((frame) / enterFrames);

    const exitStart = totalFrames - exitFrames;
    const exitProgress = frame >= exitStart
        ? clamp01(1 - (frame - exitStart) / exitFrames)
        : 1;
    const isExiting = frame >= exitStart;
    const opacity = isExiting ? exitProgress : Math.min(1, enterSpring);

    const idlePhase = enterFrames < totalFrames - exitFrames
        ? interpolate(frame, [enterFrames, totalFrames - exitFrames], [0, Math.PI * 3],
            { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
        : 0;
    const idleScale = 1 + Math.sin(idlePhase) * 0.003;

    return { frame, fps, totalFrames, enterFrames, exitFrames, enterSpring, enterLinear, exitProgress, isExiting, opacity, idleScale, speed };
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// ---------------------------------------------------------------------------
// CANVAS POSITION MAPPING
// ---------------------------------------------------------------------------

const CANVAS_POS = {
    'center':       { anchorX: 0.5, anchorY: 0.5, padX: 0, padY: 0 },
    'bottom-left':  { anchorX: 0,   anchorY: 1,   padX: 60, padY: -120 },
    'bottom-right': { anchorX: 1,   anchorY: 1,   padX: -60, padY: -120 },
    'top':          { anchorX: 0.5, anchorY: 0,   padX: 0, padY: 80 },
    'center-left':  { anchorX: 0,   anchorY: 0.5, padX: 80, padY: 0 },
    'top-left':     { anchorX: 0,   anchorY: 0,   padX: 80, padY: 80 },
};

function getAnchor(position) {
    return CANVAS_POS[position] || CANVAS_POS['center'];
}

// Get base X,Y for drawing based on position preset
function getPosXY(position, contentW, contentH) {
    const a = getAnchor(position);
    const x = a.anchorX * W + a.padX - a.anchorX * contentW;
    const y = a.anchorY * H + a.padY - a.anchorY * contentH;
    return { x, y };
}

// ---------------------------------------------------------------------------
// CANVAS DRAWING HELPERS
// ---------------------------------------------------------------------------

function setFont(ctx, weight, size, family) {
    const fam = (family || 'Arial, sans-serif').replace(/"/g, "'");
    ctx.font = `${weight} ${size}px ${fam}`;
}

function drawTextShadowed(ctx, text, x, y, s, strong) {
    // Matches makeShadow() in mg-style-utils.js exactly.
    // Glow strong:  "0 0 30px primary@90, 0 0 60px primary@40, 0 2px 12px black@90"
    // Glow weak:    "0 0 20px primary@60, 0 0 40px primary@25, 0 2px 8px black@70"
    // Non-glow strong: "0 4px 24px black@85, 0 2px 8px black@50"
    // Non-glow weak:   "0 2px 12px black@70, 0 1px 4px black@40"
    if (s.glow) {
        // Layer 0: Dark anchor shadow for readability
        ctx.shadowColor = strong ? 'rgba(0,0,0,0.9)' : 'rgba(0,0,0,0.7)';
        ctx.shadowBlur = strong ? 12 : 8;
        ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 2;
        ctx.fillText(text, x, y);
        // Layer 1: Primary glow
        ctx.shadowColor = s.primary + (strong ? '90' : '60');
        ctx.shadowBlur = strong ? 30 : 20;
        ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
        ctx.fillText(text, x, y);
        // Layer 2: Wide diffuse glow
        ctx.shadowColor = s.primary + (strong ? '40' : '25');
        ctx.shadowBlur = strong ? 60 : 40;
        ctx.fillText(text, x, y);
    } else {
        // Layer 1: Wide shadow
        ctx.shadowColor = strong ? 'rgba(0,0,0,0.85)' : 'rgba(0,0,0,0.7)';
        ctx.shadowBlur = strong ? 24 : 12;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = strong ? 4 : 2;
        ctx.fillText(text, x, y);
        // Layer 2: Tight shadow
        ctx.shadowColor = strong ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.4)';
        ctx.shadowBlur = strong ? 8 : 4;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = strong ? 2 : 1;
        ctx.fillText(text, x, y);
    }
    // Crisp text on top (no shadow)
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    ctx.fillText(text, x, y);
}

function drawGradientRect(ctx, x, y, w, h, color1, color2, direction = 'horizontal') {
    const grad = direction === 'horizontal'
        ? ctx.createLinearGradient(x, y, x + w, y)
        : ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, color1);
    grad.addColorStop(1, color2);
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
}

function measureText(ctx, text) {
    const m = ctx.measureText(text);
    return { width: m.width, height: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent };
}

function drawFullscreenBG(ctx, styleName) {
    const colors = MG_BACKGROUNDS[styleName] || MG_BACKGROUNDS.clean;
    const grad = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W / 2);
    grad.addColorStop(0, colors[0]);
    grad.addColorStop(1, colors[1]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
}

// Parse rgba string to extract components
function parseRGBA(rgba) {
    const m = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) return rgba;
    return `rgba(${m[1]},${m[2]},${m[3]},${m[4] || 1})`;
}

// ---------------------------------------------------------------------------
// MG TYPE RENDERERS
// Each: renderXxx(ctx, frame, fps, mg, s, anim, isFullScreen)
// ---------------------------------------------------------------------------

// 1. HEADLINE
function renderHeadline(ctx, frame, fps, mg, s, anim, isFullScreen) {
    const { enterSpring, enterLinear, isExiting, exitProgress, opacity, idleScale, speed } = anim;
    const scale = isExiting
        ? interpolate(exitProgress, [0, 1], [0.97, 1])
        : interpolate(enterSpring, [0, 1], [0.88, 1]);
    const translateY = isExiting
        ? interpolate(exitProgress, [0, 1], [-12, 0])
        : interpolate(enterSpring, [0, 1], [30, 0]);
    const blur = isExiting ? 0 : interpolate(enterLinear, [0, 0.6], [6, 0], { extrapolateRight: 'clamp' });

    // Accent bar — matched to Remotion: delay 0.25s, damping 20, duration 0.3s
    const barDelay = Math.round((0.25 / speed) * fps);
    const barSpring = springValue(Math.max(0, frame - barDelay), fps, { damping: 20, stiffness: 100, durationInFrames: Math.round((0.3 / speed) * fps) });
    const barWidth = barSpring * 300;

    // Subtext — matched to Remotion: damping 18
    const subDelay = Math.round(0.2 * fps);
    const subSpring = springValue(Math.max(0, frame - subDelay), fps, { damping: 18, stiffness: 100 });
    const subOpacity = isExiting ? exitProgress : subSpring;

    ctx.save();
    ctx.globalAlpha = Math.min(1, opacity);

    // Position
    const pos = getPosXY(mg.position || 'center', 800, 200);
    const cx = pos.x + 400;
    const cy = pos.y + 100;

    ctx.translate(cx, cy + translateY);
    ctx.scale(scale * idleScale, scale * idleScale);

    if (blur > 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`;

    // Main text
    setFont(ctx, '900', 72, s.fontHeading);
    ctx.fillStyle = s.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    drawTextShadowed(ctx, mg.text || '', 0, -30, s, true);

    ctx.filter = 'none';

    // Accent bar
    if (barWidth > 1) {
        drawGradientRect(ctx, -barWidth / 2, 15, barWidth, 4, s.primary, s.accent);
    }

    // Subtext
    if (mg.subtext && subOpacity > 0.01) {
        ctx.globalAlpha = Math.min(1, opacity) * subOpacity;
        setFont(ctx, '500', 26, s.fontBody);
        ctx.fillStyle = s.accent;
        drawTextShadowed(ctx, mg.subtext, 0, 50, s, false);
    }

    ctx.restore();
}

// 2. LOWER THIRD
function renderLowerThird(ctx, frame, fps, mg, s, anim, isFullScreen) {
    const { enterSpring, enterLinear, isExiting, exitProgress, opacity, idleScale, enterFrames, speed } = anim;
    const clipAmount = interpolate(enterSpring, [0, 1], [0, 100]);
    const barScaleY = springValue(Math.max(0, frame - Math.round((0.15 / speed) * fps)), fps, { damping: 20, stiffness: 120, durationInFrames: Math.round((0.35 / speed) * fps) });

    const textDelay = Math.round((0.2 / speed) * fps);
    const textSpring = springValue(Math.max(0, frame - textDelay), fps, { damping: 18, stiffness: 100, durationInFrames: Math.round((0.3 / speed) * fps) });
    const textSlideX = interpolate(textSpring, [0, 1], [-15, 0]);

    const subDelay = Math.round((0.35 / speed) * fps);
    const subSpring = springValue(Math.max(0, frame - subDelay), fps, { damping: 18, stiffness: 100 });

    ctx.save();
    ctx.globalAlpha = Math.min(1, isExiting ? exitProgress : opacity);

    // Position at bottom-left
    const baseX = 60;
    const baseY = H - 200;

    // Clip-path reveal (horizontal wipe from left)
    ctx.beginPath();
    ctx.rect(baseX, baseY - 20, 700 * (clipAmount / 100), 200);
    ctx.clip();

    // Vertical accent bar
    const accentH = 120 * barScaleY;
    drawGradientRect(ctx, baseX, baseY + 60 - accentH / 2, 4, accentH, s.primary, s.accent, 'vertical');

    // Main text
    setFont(ctx, '700', 36, s.fontHeading);
    ctx.fillStyle = s.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.globalAlpha = Math.min(1, opacity) * textSpring;
    drawTextShadowed(ctx, mg.text || '', baseX + 20 + textSlideX, baseY + 20, s, true);

    // Subtext
    if (mg.subtext) {
        ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : subSpring);
        setFont(ctx, '500', 22, s.fontBody);
        ctx.fillStyle = s.accent;
        drawTextShadowed(ctx, mg.subtext, baseX + 20, baseY + 65, s, false);
    }

    ctx.restore();
}

// 3. STAT COUNTER
function renderStatCounter(ctx, frame, fps, mg, s, anim, isFullScreen) {
    const { enterSpring, enterLinear, isExiting, exitProgress, opacity, idleScale, enterFrames, totalFrames } = anim;

    const numberMatch = (mg.text || '').match(/[\d,.]+/);
    const targetNumber = numberMatch ? parseFloat(numberMatch[0].replace(/,/g, '')) : 0;
    const prefix = (mg.text || '').substring(0, (mg.text || '').indexOf(numberMatch?.[0] || '')).trim();
    const suffix = (mg.text || '').substring((mg.text || '').indexOf(numberMatch?.[0] || '') + (numberMatch?.[0]?.length || 0)).trim();

    const countStart = Math.round(enterFrames * 0.4);
    const countEnd = Math.max(countStart + 1, Math.min(enterFrames + fps, totalFrames - 15));
    const rawCount = interpolate(frame, [countStart, countEnd], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const countProgress = easeOutCubic(rawCount);

    const currentNumber = targetNumber % 1 !== 0
        ? (targetNumber * countProgress).toFixed(1)
        : Math.round(targetNumber * countProgress).toLocaleString();

    const scale = isExiting
        ? interpolate(exitProgress, [0, 1], [0.95, 1])
        : interpolate(enterSpring, [0, 1], [0.5, 1]);
    // Matched to Remotion: blur clears at 40% (was 60%)
    const blur = isExiting ? 0 : interpolate(enterLinear, [0, 0.4], [4, 0], { extrapolateRight: 'clamp' });

    ctx.save();
    ctx.globalAlpha = Math.min(1, opacity);

    const pos = getPosXY(mg.position || 'center', 400, 150);
    const cx = pos.x + 200;
    const cy = pos.y + 75;

    ctx.translate(cx, cy);
    ctx.scale(scale * idleScale, scale * idleScale);
    if (blur > 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`;

    // Number
    setFont(ctx, '900', 96, s.fontHeading);
    ctx.fillStyle = s.accent;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    drawTextShadowed(ctx, `${prefix}${currentNumber}`, 0, -10, s, true);

    ctx.filter = 'none';

    // Label
    const label = suffix || mg.subtext || '';
    if (label) {
        setFont(ctx, '600', 28, s.fontBody);
        ctx.fillStyle = s.text;
        drawTextShadowed(ctx, label, 0, 50, s, false);
    }

    ctx.restore();
}

// 4. CALLOUT
function renderCallout(ctx, frame, fps, mg, s, anim, isFullScreen) {
    const { enterSpring, enterLinear, isExiting, exitProgress, opacity, idleScale, speed } = anim;
    const scale = isExiting
        ? interpolate(exitProgress, [0, 1], [0.97, 1])
        : interpolate(enterSpring, [0, 1], [0.92, 1]);
    const blur = isExiting ? 0 : interpolate(enterLinear, [0, 0.5], [3, 0], { extrapolateRight: 'clamp' });

    const quoteDelay = Math.round((0.1 / speed) * fps);
    const quoteSpring = springValue(Math.max(0, frame - quoteDelay), fps, { damping: 16, stiffness: 100, durationInFrames: Math.round((0.3 / speed) * fps) });
    const quoteY = interpolate(quoteSpring, [0, 1], [-15, 0]);

    ctx.save();
    ctx.globalAlpha = Math.min(1, isExiting ? exitProgress : opacity);

    // Measure text to size box
    setFont(ctx, '600', 34, s.fontHeading);
    const textWidth = Math.min(ctx.measureText(mg.text || '').width + 80, W * 0.7);
    const boxW = Math.max(400, textWidth);
    const boxH = mg.subtext ? 160 : 120;
    const pos = getPosXY(mg.position || 'center', boxW, boxH);

    ctx.translate(pos.x + boxW / 2, pos.y + boxH / 2);
    ctx.scale(scale * idleScale, scale * idleScale);
    if (blur > 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`;

    // Background box
    if (s.glow) {
        ctx.shadowColor = s.primary + '30';
        ctx.shadowBlur = 10;
        ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    } else {
        ctx.shadowColor = 'rgba(0,0,0,0.4)';
        ctx.shadowBlur = 16;
        ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 4;
    }
    roundRect(ctx, -boxW / 2, -boxH / 2, boxW, boxH, 12);
    ctx.fillStyle = s.bg;
    ctx.fill();
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
    ctx.strokeStyle = s.primary;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.filter = 'none';

    // Quote mark
    ctx.globalAlpha = Math.min(1, opacity) * quoteSpring * 0.6;
    setFont(ctx, '900', 64, s.fontHeading);
    ctx.fillStyle = s.primary;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('\u201C', -boxW / 2 + 20, -boxH / 2 - 24 + quoteY);

    // Main text (italic)
    ctx.globalAlpha = Math.min(1, isExiting ? exitProgress : opacity);
    setFont(ctx, 'italic 600', 34, s.fontHeading);
    ctx.fillStyle = s.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    drawTextShadowed(ctx, mg.text || '', 0, mg.subtext ? -15 : 0, s, false);

    // Attribution
    if (mg.subtext) {
        setFont(ctx, '500', 20, s.fontBody);
        ctx.fillStyle = s.textSub;
        ctx.fillText(`\u2014 ${mg.subtext}`, 0, boxH / 2 - 30);
    }

    ctx.restore();
}

// 5. BULLET LIST
function renderBulletList(ctx, frame, fps, mg, s, anim, isFullScreen) {
    const { enterSpring, enterFrames, isExiting, exitProgress } = anim;
    const items = (mg.text || '').split(/[,;]|\d+\.\s/).map(t => t.trim()).filter(Boolean);
    const staggerDelay = Math.round(fps * 0.25);

    ctx.save();
    ctx.globalAlpha = Math.min(1, isExiting ? exitProgress : enterSpring);

    const pos = getPosXY(mg.position || 'center-left', 600, items.length * 50);

    items.forEach((item, i) => {
        const itemDelay = Math.round(enterFrames * 0.2 + i * staggerDelay);
        const itemSpring = springValue(Math.max(0, frame - itemDelay), fps, { damping: 16, stiffness: 120 });
        const slideX = interpolate(itemSpring, [0, 1], [40, 0]);
        // Matched to Remotion: blur animation on each item during entrance
        const itemBlur = interpolate(itemSpring, [0, 0.5], [3, 0], { extrapolateRight: 'clamp' });

        const y = pos.y + i * 50;
        ctx.globalAlpha = Math.min(1, (isExiting ? exitProgress : 1)) * itemSpring;

        ctx.save();
        if (itemBlur > 0.5) ctx.filter = `blur(${itemBlur.toFixed(1)}px)`;

        // Dot
        ctx.beginPath();
        ctx.arc(pos.x + 5 + slideX, y + 15, 5, 0, Math.PI * 2);
        ctx.fillStyle = s.accent;
        ctx.fill();
        if (s.glow) {
            ctx.shadowColor = s.accent + '80';
            ctx.shadowBlur = 8;
            ctx.fill();
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
        }

        // Text
        setFont(ctx, '600', 30, s.fontBody);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        drawTextShadowed(ctx, item, pos.x + 26 + slideX, y + 15, s, false);

        ctx.restore();
    });

    ctx.restore();
}

// 6. FOCUS WORD
// Helper: wrap text into lines that fit within maxWidth
function wrapTextWords(ctx, text, maxWidth) {
    const words = text.split(/\s+/);
    if (words.length <= 1) return [text];
    const lines = [];
    let currentLine = words[0];
    for (let i = 1; i < words.length; i++) {
        const test = currentLine + ' ' + words[i];
        if (ctx.measureText(test).width <= maxWidth) {
            currentLine = test;
        } else {
            lines.push(currentLine);
            currentLine = words[i];
        }
    }
    lines.push(currentLine);
    return lines;
}

function renderFocusWord(ctx, frame, fps, mg, s, anim, isFullScreen) {
    const { enterLinear, isExiting, exitProgress, opacity } = anim;
    const speed = mg._animationSpeed || 1.0;

    const snapSpring = springValue(frame, fps, { damping: 20, stiffness: 250, durationInFrames: Math.round((0.4 / speed) * fps) });
    const scale = isExiting
        ? interpolate(exitProgress, [0, 1], [1.3, 1])
        : interpolate(snapSpring, [0, 1], [1.8, 1]);
    const blur = isExiting
        ? interpolate(exitProgress, [0, 1], [6, 0])
        : interpolate(enterLinear, [0, 0.3], [8, 0], { extrapolateRight: 'clamp' });
    const letterSpacing = interpolate(snapSpring, [0, 1], [20, 2]);
    const scrimOpacity = interpolate(enterLinear, [0, 0.15], [0, 0.3], { extrapolateRight: 'clamp' }) * (isExiting ? exitProgress : 1);

    ctx.save();

    // Dark scrim overlay for contrast — Remotion always draws this (no isFullScreen check)
    ctx.fillStyle = `rgba(0,0,0,${scrimOpacity.toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);

    ctx.globalAlpha = Math.min(1, opacity);
    ctx.translate(W / 2, H / 2);
    ctx.scale(scale, scale);
    if (blur > 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`;

    const word = (mg.text || '').toUpperCase();

    // Auto-size font: start at 96, shrink if text wraps to too many lines
    // Remotion uses CSS which auto-wraps at container width; canvas needs manual sizing
    const maxTextWidth = W * 0.8; // 80% of canvas width
    let fontSize = 96;
    setFont(ctx, '900', fontSize, s.fontHeading);
    let lines = wrapTextWords(ctx, word, maxTextWidth);
    // Shrink font if more than 2 lines
    while (lines.length > 2 && fontSize > 48) {
        fontSize -= 4;
        setFont(ctx, '900', fontSize, s.fontHeading);
        lines = wrapTextWords(ctx, word, maxTextWidth);
    }

    ctx.fillStyle = s.accent;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const lineHeight = fontSize * 1.1;
    const totalTextHeight = lines.length * lineHeight;
    const startY = -totalTextHeight / 2 + lineHeight / 2;

    // Draw each line with letter spacing animation
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const lineText = lines[lineIdx];
        const lineY = startY + lineIdx * lineHeight;

        if (letterSpacing > 3) {
            // Manual letter spacing — draw char by char
            const chars = lineText.split('');
            const charWidths = chars.map(c => ctx.measureText(c).width);
            const totalW = charWidths.reduce((a, b) => a + b, 0) + (chars.length - 1) * letterSpacing;
            let cx = -totalW / 2;
            for (let i = 0; i < chars.length; i++) {
                const charX = cx + charWidths[i] / 2;
                if (s.glow) {
                    ctx.shadowColor = s.accent + '40';
                    ctx.shadowBlur = 80;
                    ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
                    ctx.fillText(chars[i], charX, lineY);
                    ctx.shadowColor = s.accent + 'cc';
                    ctx.shadowBlur = 40;
                    ctx.fillText(chars[i], charX, lineY);
                } else {
                    ctx.shadowColor = 'rgba(0,0,0,0.9)';
                    ctx.shadowBlur = 30;
                    ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 4;
                    ctx.fillText(chars[i], charX, lineY);
                }
                ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
                ctx.fillText(chars[i], charX, lineY);
                cx += charWidths[i] + letterSpacing;
            }
        } else {
            drawTextShadowed(ctx, lineText, 0, lineY, s, true);
        }
    }

    ctx.filter = 'none';

    // Subtext
    if (mg.subtext) {
        const subOpacity = interpolate(enterLinear, [0.5, 0.75], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
            * (isExiting ? exitProgress : 1);
        ctx.globalAlpha = Math.min(1, opacity) * subOpacity;
        setFont(ctx, '500', 28, s.fontBody);
        ctx.fillStyle = s.textSub;
        const subY = startY + lines.length * lineHeight + 20;
        drawTextShadowed(ctx, mg.subtext, 0, subY, s, false);
    }

    ctx.restore();
}

// 7. PROGRESS BAR
function renderProgressBar(ctx, frame, fps, mg, s, anim, isFullScreen) {
    const { enterSpring, enterLinear, isExiting, exitProgress, opacity, idleScale, enterFrames, totalFrames } = anim;

    const numMatch = (mg.text || '').match(/[\d,.]+/);
    const targetPct = numMatch ? Math.min(100, parseFloat(numMatch[0].replace(/,/g, ''))) : 75;
    const label = (mg.text || '').replace(/[\d,.]+%?/, '').trim() || mg.subtext || '';

    const fillStart = Math.round(enterFrames * 0.5);
    // Matched to Remotion: fill duration +0.3s (was +1.2s — 4x too slow)
    const fillEnd = Math.max(fillStart + 1, Math.min(enterFrames + Math.round(fps * 0.3), totalFrames - 15));
    const fillProgress = easeOutCubic(interpolate(frame, [fillStart, fillEnd], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
    const currentPct = Math.round(targetPct * fillProgress);

    const scale = isExiting
        ? interpolate(exitProgress, [0, 1], [0.97, 1])
        : interpolate(enterSpring, [0, 1], [0.9, 1]);

    ctx.save();
    ctx.globalAlpha = Math.min(1, opacity);

    const barW = W * 0.6;
    const pos = getPosXY(mg.position || 'center', barW, 120);
    const cx = pos.x + barW / 2;
    const cy = pos.y + 60;

    ctx.translate(cx, cy);
    ctx.scale(scale * idleScale, scale * idleScale);

    // Label
    if (label) {
        setFont(ctx, '700', 28, s.fontBody);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        drawTextShadowed(ctx, label, 0, -40, s, false);
    }

    // Track
    const trackW = barW;
    const trackH = 24;
    roundRect(ctx, -trackW / 2, -trackH / 2, trackW, trackH, 12);
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Fill
    const fillW = trackW * (targetPct * fillProgress / 100);
    if (fillW > 1) {
        roundRect(ctx, -trackW / 2, -trackH / 2, fillW, trackH, 12);
        const grad = ctx.createLinearGradient(-trackW / 2, 0, -trackW / 2 + fillW, 0);
        grad.addColorStop(0, s.primary);
        grad.addColorStop(1, s.accent);
        ctx.fillStyle = grad;
        if (s.glow) { ctx.shadowColor = s.primary + '80'; ctx.shadowBlur = 16; }
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
    }

    // Percentage
    setFont(ctx, '900', 48, s.fontHeading);
    ctx.fillStyle = s.accent;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    drawTextShadowed(ctx, `${currentPct}%`, 0, 45, s, true);

    ctx.restore();
}

// 8. BAR CHART
function renderBarChart(ctx, frame, fps, mg, s, anim, isFullScreen) {
    const { enterFrames, isExiting, exitProgress, opacity, idleScale } = anim;
    const items = parseKeyValuePairs(mg.subtext);
    const maxVal = Math.max(...items.map(i => parseFloat(i.value) || 0), 1);
    const staggerDelay = Math.round(fps * 0.15);
    const barCount = Math.min(items.length, 6);

    ctx.save();
    ctx.globalAlpha = Math.min(1, opacity);

    const chartW = W * 0.6;
    const chartH = 300;
    const pos = getPosXY(mg.position || 'center', chartW, chartH + 80);
    const cx = pos.x + chartW / 2;
    const topY = pos.y;

    ctx.translate(cx, topY);
    ctx.scale(idleScale, idleScale);

    // Title
    setFont(ctx, '700', 36, s.fontHeading);
    ctx.fillStyle = s.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    drawTextShadowed(ctx, mg.text || '', 0, 0, s, true);

    // Bars
    const barAreaW = chartW;
    const barGap = 20;
    const singleBarW = (barAreaW - (barCount - 1) * barGap) / barCount;
    const barAreaTop = 60;
    const barAreaH = chartH;

    for (let i = 0; i < barCount; i++) {
        const item = items[i];
        const barDelay = Math.round(enterFrames * 0.3 + i * staggerDelay);
        const barSpring = springValue(Math.max(0, frame - barDelay), fps, { damping: 14, stiffness: 80 });
        const numVal = parseFloat(item.value) || 0;
        const heightPct = (numVal / maxVal);
        const barH = heightPct * barSpring * (barAreaH - 40);
        const bx = -barAreaW / 2 + i * (singleBarW + barGap);
        const by = barAreaTop + barAreaH - barH;

        // Value label
        const valDelay = barDelay + Math.round(fps * 0.2);
        const valOpacity = interpolate(frame, [valDelay, valDelay + Math.round(fps * 0.15)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : valOpacity);
        setFont(ctx, '700', 24, s.fontHeading);
        ctx.fillStyle = s.accent;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        drawTextShadowed(ctx, item.value, bx + singleBarW / 2, by - 6, s, false);

        // Bar
        ctx.globalAlpha = Math.min(1, opacity);
        if (barH > 0) {
            const grad = ctx.createLinearGradient(0, by, 0, by + barH);
            grad.addColorStop(0, s.accent);
            grad.addColorStop(1, s.primary);
            ctx.fillStyle = grad;
            roundRect(ctx, bx, by, singleBarW, barH, 6);
            if (s.glow) { ctx.shadowColor = s.primary + '60'; ctx.shadowBlur = 12; }
            ctx.fill();
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        }

        // Label
        setFont(ctx, '500', 18, s.fontBody);
        ctx.fillStyle = s.textSub;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(item.label, bx + singleBarW / 2, barAreaTop + barAreaH + 8);
    }

    ctx.restore();
}

// 9. DONUT CHART
function renderDonutChart(ctx, frame, fps, mg, s, anim, isFullScreen) {
    const { enterSpring, enterFrames, isExiting, exitProgress, opacity, idleScale } = anim;
    const items = parseKeyValuePairs(mg.subtext);
    const total = items.reduce((sum, i) => sum + (parseFloat(i.value) || 0), 0) || 100;
    const radius = 100;
    const strokeWidth = 30;
    const staggerDelay = Math.round(fps * 0.2);
    const segColors = [s.primary, s.accent, s.primary + 'bb', s.accent + 'bb', s.primary + '88'];

    const scale = isExiting
        ? interpolate(exitProgress, [0, 1], [0.95, 1])
        : interpolate(enterSpring, [0, 1], [0.7, 1]);

    ctx.save();
    ctx.globalAlpha = Math.min(1, opacity);

    const pos = getPosXY(mg.position || 'center', 520, 300);
    const ringCX = pos.x + 130;
    const ringCY = pos.y + 170;

    ctx.translate(pos.x + 260, pos.y + 150);
    ctx.scale(scale * idleScale, scale * idleScale);

    // Title
    setFont(ctx, '700', 32, s.fontHeading);
    ctx.fillStyle = s.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    drawTextShadowed(ctx, mg.text || '', 0, -140, s, true);

    // Draw ring segments
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = 'round';
    let cumulativeAngle = -Math.PI / 2; // start at top

    items.slice(0, 5).forEach((item, i) => {
        const pct = (parseFloat(item.value) || 0) / total;
        const segAngle = pct * Math.PI * 2;
        const drawDelay = Math.round(enterFrames * 0.2 + i * staggerDelay);
        const drawProgress = easeOutCubic(interpolate(frame, [drawDelay, drawDelay + Math.round(fps * 0.5)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
        const drawAngle = segAngle * drawProgress;

        if (drawAngle > 0.01) {
            ctx.beginPath();
            ctx.arc(-130, 20, radius, cumulativeAngle, cumulativeAngle + drawAngle);
            ctx.strokeStyle = segColors[i % segColors.length];
            ctx.stroke();
        }
        cumulativeAngle += segAngle;
    });

    // Center label
    const centerDelay = Math.round(enterFrames * 0.4);
    const centerOpacity = interpolate(frame, [centerDelay, centerDelay + Math.round(fps * 0.3)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : centerOpacity);
    setFont(ctx, '900', 36, s.fontHeading);
    ctx.fillStyle = s.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const mainPct = items.length > 0 ? Math.round((parseFloat(items[0].value) || 0) / total * 100) : 0;
    drawTextShadowed(ctx, `${mainPct}%`, -130, 20, s, false);

    // Legend
    items.slice(0, 5).forEach((item, i) => {
        const legendDelay = Math.round(enterFrames * 0.5 + i * Math.round(fps * 0.12));
        const legendOpacity = interpolate(frame, [legendDelay, legendDelay + Math.round(fps * 0.2)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : legendOpacity);

        const ly = -40 + i * 30;
        // Color dot
        ctx.beginPath();
        ctx.arc(30, ly, 7, 0, Math.PI * 2);
        ctx.fillStyle = segColors[i % segColors.length];
        ctx.fill();
        // Label
        setFont(ctx, '500', 20, s.fontBody);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(item.label, 45, ly);
        // Value
        ctx.fillStyle = s.textSub;
        setFont(ctx, '600', 20, s.fontBody);
        ctx.fillText(`${item.value}%`, 45 + ctx.measureText(item.label).width + 10, ly);
    });

    ctx.restore();
}

// 10. COMPARISON CARD
function renderComparisonCard(ctx, frame, fps, mg, s, anim, isFullScreen) {
    const { enterSpring, isExiting, exitProgress, opacity, idleScale, speed } = anim;

    const parts = (mg.text || '').split(/\s+vs\.?\s+/i);
    const itemA = parts[0] || 'A';
    const itemB = parts[1] || 'B';

    const slideX = isExiting
        ? interpolate(exitProgress, [0, 1], [60, 0])
        : interpolate(enterSpring, [0, 1], [200, 0]);

    const vsDelay = Math.round((0.3 / speed) * fps);
    const vsSpring = springValue(Math.max(0, frame - vsDelay), fps, { damping: 12, stiffness: 150, durationInFrames: Math.round((0.4 / speed) * fps) });

    const subDelay = Math.round((0.5 / speed) * fps);
    const subOpacity = interpolate(frame, [subDelay, subDelay + Math.round((0.3 / speed) * fps)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

    ctx.save();
    ctx.globalAlpha = Math.min(1, opacity);

    const boxW = W * 0.35;
    const boxH = 120;
    const gap = 100;
    const totalW = boxW * 2 + gap;
    const pos = getPosXY(mg.position || 'center', totalW, boxH);
    const cx = pos.x + totalW / 2;
    const cy = pos.y + boxH / 2;

    ctx.translate(cx, cy);
    ctx.scale(idleScale, idleScale);

    // Left box
    ctx.save();
    ctx.translate(-boxW / 2 - gap / 2 - slideX, 0);
    roundRect(ctx, -boxW / 2, -boxH / 2, boxW, boxH, 16);
    ctx.fillStyle = s.primary + '25';
    ctx.fill();
    ctx.strokeStyle = s.primary + '40';
    ctx.lineWidth = 2;
    ctx.stroke();
    setFont(ctx, '800', 42, s.fontHeading);
    ctx.fillStyle = s.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    drawTextShadowed(ctx, itemA.toUpperCase(), 0, 0, s, true);
    ctx.restore();

    // Right box
    ctx.save();
    ctx.translate(boxW / 2 + gap / 2 + slideX, 0);
    roundRect(ctx, -boxW / 2, -boxH / 2, boxW, boxH, 16);
    ctx.fillStyle = s.accent + '25';
    ctx.fill();
    ctx.strokeStyle = s.accent + '40';
    ctx.lineWidth = 2;
    ctx.stroke();
    setFont(ctx, '800', 42, s.fontHeading);
    ctx.fillStyle = s.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    drawTextShadowed(ctx, itemB.toUpperCase(), 0, 0, s, true);
    ctx.restore();

    // VS circle
    ctx.save();
    ctx.scale(vsSpring, vsSpring);
    ctx.beginPath();
    ctx.arc(0, 0, 40, 0, Math.PI * 2);
    const vsGrad = ctx.createLinearGradient(-40, -40, 40, 40);
    vsGrad.addColorStop(0, s.primary);
    vsGrad.addColorStop(1, s.accent);
    ctx.fillStyle = vsGrad;
    if (s.glow) { ctx.shadowColor = s.primary + '80'; ctx.shadowBlur = 24; }
    else { ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 20; }
    ctx.fill();
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
    setFont(ctx, '900', 28, s.fontHeading);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('VS', 0, 0);
    ctx.restore();

    // Subtext
    if (mg.subtext && mg.subtext !== 'none') {
        ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : subOpacity);
        setFont(ctx, '500', 22, s.fontBody);
        ctx.fillStyle = s.textSub;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        drawTextShadowed(ctx, mg.subtext, 0, boxH / 2 + 40, s, false);
    }

    ctx.restore();
}

// 11. TIMELINE
function renderTimeline(ctx, frame, fps, mg, s, anim, isFullScreen) {
    const { enterSpring, enterFrames, isExiting, exitProgress, opacity, idleScale } = anim;
    const items = parseKeyValuePairs(mg.subtext);
    const staggerDelay = Math.round(fps * 0.25);
    const lineWidth = interpolate(enterSpring, [0, 1], [0, 100]);

    ctx.save();
    ctx.globalAlpha = Math.min(1, opacity);

    const tlW = W * 0.75;
    const pos = getPosXY(mg.position || 'center', tlW, 200);
    const cx = pos.x + tlW / 2;
    const cy = pos.y + 100;

    ctx.translate(cx, cy);
    ctx.scale(idleScale, idleScale);

    // Title
    if (mg.text) {
        setFont(ctx, '700', 32, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        drawTextShadowed(ctx, mg.text, 0, -70, s, true);
    }

    // Horizontal line
    const lineW = tlW * lineWidth / 100;
    if (lineW > 0) {
        drawGradientRect(ctx, -tlW / 2, -1.5, lineW, 3, s.primary, s.accent);
        if (s.glow) {
            ctx.shadowColor = s.primary + '60';
            ctx.shadowBlur = 8;
            ctx.fillRect(-tlW / 2, -1.5, lineW, 3);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        }
    }

    // Markers
    items.slice(0, 5).forEach((item, i) => {
        const pct = items.length > 1 ? i / (items.length - 1) : 0.5;
        const mx = -tlW / 2 + pct * tlW;
        const markerDelay = Math.round(enterFrames * 0.3 + i * staggerDelay);
        const markerSpring = springValue(Math.max(0, frame - markerDelay), fps, { damping: 16, stiffness: 120 });
        const slideY = interpolate(markerSpring, [0, 1], [-25, 0]);

        ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : markerSpring);

        // Label above
        setFont(ctx, '700', 22, s.fontHeading);
        ctx.fillStyle = s.accent;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        drawTextShadowed(ctx, item.label, mx, -12 + slideY, s, false);

        // Dot
        ctx.beginPath();
        ctx.arc(mx, slideY, 7, 0, Math.PI * 2);
        ctx.fillStyle = s.accent;
        ctx.strokeStyle = s.text;
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
        if (s.glow) { ctx.shadowColor = s.accent + '80'; ctx.shadowBlur = 10; ctx.fill(); ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; }

        // Value below
        setFont(ctx, '500', 18, s.fontBody);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        drawTextShadowed(ctx, item.value, mx, 16 + slideY, s, false);
    });

    ctx.restore();
}

// 12. RANKING LIST
function renderRankingList(ctx, frame, fps, mg, s, anim, isFullScreen) {
    const { enterFrames, isExiting, exitProgress, opacity, idleScale } = anim;
    const items = parseKeyValuePairs(mg.subtext);
    const maxVal = Math.max(...items.map(i => parseFloat(i.value) || 0), 1);
    const staggerDelay = Math.round(fps * 0.18);

    ctx.save();
    ctx.globalAlpha = Math.min(1, opacity);

    const listW = W * 0.55;
    const rowH = 50;
    const pos = getPosXY(mg.position || 'center-left', listW, items.length * rowH + 60);

    ctx.translate(pos.x, pos.y);
    ctx.scale(idleScale, idleScale);

    // Title
    setFont(ctx, '700', 34, s.fontHeading);
    ctx.fillStyle = s.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    drawTextShadowed(ctx, mg.text || '', 0, 0, s, true);

    items.slice(0, 6).forEach((item, i) => {
        const rowDelay = Math.round(enterFrames * 0.2 + i * staggerDelay);
        const rowSpring = springValue(Math.max(0, frame - rowDelay), fps, { damping: 16, stiffness: 120 });
        const slideX = interpolate(rowSpring, [0, 1], [50, 0]);
        // Matched to Remotion: blur animation on each row during entrance
        const rowBlur = interpolate(rowSpring, [0, 0.5], [3, 0], { extrapolateRight: 'clamp' });
        const numVal = parseFloat(item.value) || 0;
        const barDelay = rowDelay + Math.round(fps * 0.15);
        const barRaw = interpolate(frame, [barDelay, barDelay + Math.round(fps * 0.6)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const barWidth = easeOutCubic(barRaw) * (numVal / maxVal) * (listW - 60);
        const isTop = i === 0;
        const ry = 50 + i * rowH;

        ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : rowSpring);

        ctx.save();
        if (rowBlur > 0.5) ctx.filter = `blur(${rowBlur.toFixed(1)}px)`;

        // Rank number
        setFont(ctx, '900', 30, s.fontHeading);
        ctx.fillStyle = isTop ? s.accent : s.textSub;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        drawTextShadowed(ctx, `${i + 1}`, 24 + slideX, ry + 20, s, isTop);

        // Label + Value
        setFont(ctx, '600', 22, s.fontBody);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        drawTextShadowed(ctx, item.label, 60 + slideX, ry + 12, s, false);

        setFont(ctx, '700', 20, s.fontHeading);
        ctx.fillStyle = s.accent;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(item.value, listW + slideX, ry + 12);

        ctx.filter = 'none';

        // Bar background
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        roundRect(ctx, 60 + slideX, ry + 28, listW - 60, 8, 4);
        ctx.fill();

        // Bar fill
        if (barWidth > 0) {
            const barGrad = ctx.createLinearGradient(60, 0, 60 + barWidth, 0);
            barGrad.addColorStop(0, isTop ? s.accent : s.primary + '99');
            barGrad.addColorStop(1, isTop ? s.primary : s.primary + '55');
            ctx.fillStyle = barGrad;
            roundRect(ctx, 60 + slideX, ry + 28, barWidth, 8, 4);
            ctx.fill();
        }

        ctx.restore();
    });

    ctx.restore();
}

// 13. KINETIC TEXT
function renderKineticText(ctx, frame, fps, mg, s, anim, isFullScreen) {
    const { enterLinear, isExiting, exitProgress, opacity } = anim;

    const words = (mg.text || '').split(/\s+/);
    const staggerDelay = Math.round(fps * 0.08);

    ctx.save();
    ctx.globalAlpha = Math.min(1, opacity);

    // Layout words in a centered grid
    setFont(ctx, '800', 60, s.fontHeading);
    const wordWidths = words.map(w => ctx.measureText(w).width);
    const gap = 18;
    const maxRowW = W * 0.7;

    // Wrap words into rows
    const rows = [];
    let currentRow = [];
    let currentW = 0;
    for (let i = 0; i < words.length; i++) {
        if (currentW + wordWidths[i] + (currentRow.length > 0 ? gap : 0) > maxRowW && currentRow.length > 0) {
            rows.push(currentRow);
            currentRow = [];
            currentW = 0;
        }
        currentRow.push({ word: words[i], width: wordWidths[i], index: i });
        currentW += wordWidths[i] + gap;
    }
    if (currentRow.length > 0) rows.push(currentRow);

    const rowHeight = 80;
    const totalH = rows.length * rowHeight;
    const startY = H / 2 - totalH / 2;

    rows.forEach((row, ri) => {
        const rowW = row.reduce((a, r) => a + r.width, 0) + (row.length - 1) * gap;
        let rx = W / 2 - rowW / 2;

        row.forEach((entry) => {
            const wordDelay = entry.index * staggerDelay;
            const wordSpring = springValue(Math.max(0, frame - wordDelay), fps, { damping: 16, stiffness: 120 });
            const wordScale = interpolate(wordSpring, [0, 1], [1.5, 1]);
            const wordOpacity = wordSpring;
            const wordBlur = interpolate(wordSpring, [0, 0.5], [6, 0], { extrapolateRight: 'clamp' });

            ctx.save();
            ctx.globalAlpha = Math.min(1, opacity) * wordOpacity * (isExiting ? exitProgress : 1);
            ctx.translate(rx + entry.width / 2, startY + ri * rowHeight + rowHeight / 2);
            ctx.scale(wordScale, wordScale);
            if (wordBlur > 0.5) ctx.filter = `blur(${wordBlur.toFixed(1)}px)`;

            setFont(ctx, '800', 60, s.fontHeading);
            ctx.fillStyle = s.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            drawTextShadowed(ctx, entry.word, 0, 0, s, true);

            ctx.restore();
            rx += entry.width + gap;
        });
    });

    ctx.restore();
}

// 14. SUBSCRIBE CTA
function renderSubscribeCTA(ctx, frame, fps, mg, s, anim, isFullScreen) {
    const { totalFrames, opacity } = anim;

    const progress = frame / totalFrames;
    const pulseScale = Math.sin(progress * Math.PI * 4 * 2) * 0.05 + 1;
    const fadeIn = interpolate(frame, [0, Math.round(0.3 * fps)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const fadeOut = interpolate(frame, [totalFrames - Math.round(0.4 * fps), totalFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const alpha = Math.min(fadeIn, fadeOut);

    ctx.save();
    ctx.globalAlpha = Math.min(1, alpha);

    const text = mg.text || 'Subscribe';
    setFont(ctx, 'bold', 28, s.fontHeading);
    const textW = ctx.measureText(text).width;
    const pillW = textW + 100; // bell emoji + padding
    const pillH = 60;

    const pos = getPosXY(mg.position || 'bottom-right', pillW, pillH);
    const cx = pos.x + pillW / 2;
    const cy = pos.y + pillH / 2;

    ctx.translate(cx, cy);
    ctx.scale(pulseScale, pulseScale);

    // Pill background
    roundRect(ctx, -pillW / 2, -pillH / 2, pillW, pillH, 30);
    const grad = ctx.createLinearGradient(-pillW / 2, 0, pillW / 2, 0);
    grad.addColorStop(0, s.primary);
    grad.addColorStop(1, s.accent);
    ctx.fillStyle = grad;
    if (s.glow) { ctx.shadowColor = s.primary + '80'; ctx.shadowBlur = 20; }
    else { ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 12; }
    ctx.fill();
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

    // Bell + text
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    setFont(ctx, 'normal', 32, 'Segoe UI Emoji, Arial');
    ctx.fillText('\uD83D\uDD14', -pillW / 2 + 36, 1); // bell emoji
    setFont(ctx, 'bold', 28, s.fontHeading);
    ctx.fillText(text, 18, 0);

    ctx.restore();
}

// ---------------------------------------------------------------------------
// RENDERER REGISTRY
// ---------------------------------------------------------------------------

const CANVAS_RENDERERS = {
    headline: renderHeadline,
    lowerThird: renderLowerThird,
    statCounter: renderStatCounter,
    callout: renderCallout,
    bulletList: renderBulletList,
    focusWord: renderFocusWord,
    progressBar: renderProgressBar,
    barChart: renderBarChart,
    donutChart: renderDonutChart,
    comparisonCard: renderComparisonCard,
    timeline: renderTimeline,
    rankingList: renderRankingList,
    kineticText: renderKineticText,
    subscribeCTA: renderSubscribeCTA,
};

// MG types that must fall back to Remotion
const REMOTION_ONLY_TYPES = new Set(['mapChart', 'articleHighlight', 'animatedIcons']);

function canRenderWithCanvas(mgType) {
    return CANVAS_RENDERERS.hasOwnProperty(mgType) && !REMOTION_ONLY_TYPES.has(mgType);
}

// ---------------------------------------------------------------------------
// SINGLE MG → WebM PIPE
// ---------------------------------------------------------------------------

async function renderMGToWebM(mg, outputPath, fps, scriptContext, isFullScreen) {
    const { createCanvas } = getCanvasModule();
    const canvas = createCanvas(PW, PH);  // physical resolution (e.g. 3840x2160 at 2x)
    const ctx = canvas.getContext('2d');
    // Per-MG animationSpeed overrides global scriptContext.mgAnimationSpeed
    mg._animationSpeed = mg.animationSpeed || scriptContext.mgAnimationSpeed || 1.0;
    const s = getStyle(mg, scriptContext);
    const totalFrames = Math.max(1, Math.round((mg.duration || 3) * fps));
    const renderFn = CANVAS_RENDERERS[mg.type];

    if (!renderFn) {
        throw new Error(`No canvas renderer for MG type: ${mg.type}`);
    }

    // Spawn FFmpeg: raw RGBA → downscale (if supersampled) → FFV1 lossless in MKV with guaranteed alpha.
    // Supersampling at 2x then downscaling gives smooth anti-aliased text edges.
    const vfArgs = SUPERSAMPLE > 1
        ? ['-vf', `scale=${W}:${H}:flags=lanczos`]
        : [];
    const ffmpeg = spawn(FFMPEG_PATH, [
        '-y',
        '-f', 'rawvideo',
        '-pixel_format', 'rgba',
        '-video_size', `${PW}x${PH}`,
        '-framerate', String(fps),
        '-i', 'pipe:0',
        ...vfArgs,
        '-c:v', 'ffv1',
        '-pix_fmt', 'yuva444p',
        '-level', '3',
        '-an',
        outputPath
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let ffmpegError = '';
    ffmpeg.stderr.on('data', d => { ffmpegError += d.toString(); });

    for (let frame = 0; frame < totalFrames; frame++) {
        ctx.clearRect(0, 0, PW, PH);  // physical pixels, no transform active

        // Apply supersampling scale — all renderers work in logical 1920x1080 coordinates
        ctx.save();
        ctx.scale(S, S);

        // FocusWord and kineticText are transparent overlays (scrim handled internally)
        // Other fullscreen MGs get opaque background + scale(1.5)
        const transparentFullscreen = isFullScreen && (mg.type === 'focusWord' || mg.type === 'kineticText');
        if (isFullScreen && !transparentFullscreen) {
            drawFullscreenBG(ctx, mg.style || 'clean');
            ctx.save();
            ctx.translate(W / 2, H / 2);
            ctx.scale(1.5, 1.5);
            ctx.translate(-W / 2, -H / 2);
        }

        const anim = computeAnimationState(frame, fps, mg);
        renderFn(ctx, frame, fps, mg, s, anim, isFullScreen);

        if (isFullScreen && !transparentFullscreen) ctx.restore();

        ctx.restore();  // pop supersampling scale

        // Get raw RGBA at physical resolution and pipe to FFmpeg
        const imageData = ctx.getImageData(0, 0, PW, PH);
        const buf = Buffer.from(imageData.data.buffer);

        // Diagnostic: check alpha channel on first frame of first non-fullscreen MG
        if (frame === 0 && !isFullScreen && !renderMGToWebM._alphaChecked) {
            renderMGToWebM._alphaChecked = true;
            const data = imageData.data;
            let transparentPixels = 0;
            let opaquePixels = 0;
            // Sample every 100th pixel for speed
            for (let i = 3; i < data.length; i += 400) {
                if (data[i] === 0) transparentPixels++;
                else opaquePixels++;
            }
            const total = transparentPixels + opaquePixels;
            const pctTransparent = total > 0 ? ((transparentPixels / total) * 100).toFixed(1) : 0;
            console.log(`  [CanvasMG] Alpha diagnostic (${mg.type}): ${pctTransparent}% transparent pixels (${transparentPixels}/${total} sampled) — overlay should be mostly transparent`);
        }

        const canWrite = ffmpeg.stdin.write(buf);
        if (!canWrite) {
            await new Promise(resolve => ffmpeg.stdin.once('drain', resolve));
        }
    }

    ffmpeg.stdin.end();

    await new Promise((resolve, reject) => {
        ffmpeg.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg FFV1 encode failed (code ${code}): ${ffmpegError.slice(-500)}`));
        });
        ffmpeg.on('error', reject);
    });
}

// ---------------------------------------------------------------------------
// BATCH ORCHESTRATOR
// ---------------------------------------------------------------------------

/**
 * Render all canvas-compatible MGs to individual MKV clips (FFV1 lossless with alpha).
 * @param {Array} mgEntries - [{ mg, isFullScreen, originalIndex, category }]
 * @param {string} clipDir - output directory for MKV clips
 * @param {number} fps
 * @param {object} scriptContext
 * @param {function} progressCb - (progress 0-1)
 */
async function renderAll(mgEntries, clipDir, fps, scriptContext, progressCb) {
    if (!mgEntries || mgEntries.length === 0) return;

    // Reset diagnostic flag for this render session
    renderMGToWebM._alphaChecked = false;

    console.log(`  [CanvasMG] Encoding ${mgEntries.length} MGs with FFV1 lossless (yuva444p) for guaranteed alpha transparency`);

    const overlayCount = mgEntries.filter(e => !e.isFullScreen).length;
    const fsCount = mgEntries.filter(e => e.isFullScreen).length;
    console.log(`  [CanvasMG] ${overlayCount} overlay MGs (transparent bg), ${fsCount} fullscreen MGs (opaque bg)`);

    const MG_PARALLEL = 4;
    let done = 0;

    const tasks = mgEntries.map((entry) => async () => {
        const prefix = entry.category; // 'overlay' or 'fullscreen'
        const idx = entry.originalIndex;
        const outFile = path.join(clipDir, `mg-${prefix}-${idx}.mkv`);

        try {
            await renderMGToWebM(entry.mg, outFile, fps, scriptContext, entry.isFullScreen);
            // Log file size as sanity check
            if (fs.existsSync(outFile)) {
                const sizeKB = (fs.statSync(outFile).size / 1024).toFixed(0);
                console.log(`  [CanvasMG] ${prefix}-${idx} (${entry.mg.type}): ${sizeKB}KB`);
            }
        } catch (err) {
            console.error(`  [CanvasMG] Failed to render ${entry.mg.type} (${prefix}-${idx}): ${err.message}`);
        }

        done++;
        if (progressCb) progressCb(done / mgEntries.length);
    });

    // Run MG renders in parallel (each spawns its own FFmpeg FFV1 encoder)
    const executing = new Set();
    for (const task of tasks) {
        const p = task().then(() => executing.delete(p));
        executing.add(p);
        if (executing.size >= MG_PARALLEL) {
            await Promise.race(executing);
        }
    }
    await Promise.all(executing);

    // Post-encode verification: probe the first overlay MG clip for alpha
    const firstOverlay = mgEntries.find(e => !e.isFullScreen);
    if (firstOverlay) {
        const probeFile = path.join(clipDir, `mg-overlay-${firstOverlay.originalIndex}.mkv`);
        if (fs.existsSync(probeFile)) {
            try {
                const FFPROBE = process.env.FFPROBE_PATH || 'C:\\ffmg\\bin\\ffprobe.exe';
                const { execFile } = require('child_process');
                const probeResult = await new Promise((resolve) => {
                    execFile(FFPROBE, [
                        '-v', 'error',
                        '-select_streams', 'v:0',
                        '-show_entries', 'stream=pix_fmt,codec_name',
                        '-of', 'json',
                        probeFile
                    ], { timeout: 10000 }, (err, stdout) => {
                        if (err) { resolve(null); return; }
                        try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
                    });
                });
                if (probeResult?.streams?.[0]) {
                    const stream = probeResult.streams[0];
                    const hasAlpha = stream.pix_fmt && stream.pix_fmt.includes('a');
                    console.log(`  [CanvasMG] Probe overlay clip: codec=${stream.codec_name} pix_fmt=${stream.pix_fmt} alpha=${hasAlpha ? 'YES' : 'NO!!!'}`);
                    if (!hasAlpha) {
                        console.error(`  [CanvasMG] WARNING: MG overlay clip has NO alpha channel! Overlays will appear on black background.`);
                    }
                }
            } catch (e) {
                console.log(`  [CanvasMG] Could not probe MG clip: ${e.message}`);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

module.exports = {
    renderAll,
    renderMGToWebM,
    canRenderWithCanvas,
    REMOTION_ONLY_TYPES,
    CANVAS_RENDERERS,
    // Shared utilities for mg-png-renderer.js (Phase 4B)
    getCanvasModule,
    computeAnimationState,
    springValue,
    interpolate,
    easeOutCubic,
    CANVAS_POS,
    getAnchor,
};
