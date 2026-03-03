/**
 * MGRenderer.js — Motion Graphics renderer via Canvas2D -> WebGL texture
 * Renders MG overlays to an offscreen canvas, then uploads as a texture.
 *
 * For Slice 0: only 'headline' type is implemented.
 * The rendering code is ported directly from src/canvas-mg-renderer.js.
 */

class MGRenderer {
    constructor(textureManager, fps) {
        this.textureManager = textureManager;
        this.fps = fps;
        // Offscreen canvas for 2D drawing (full 1920x1080)
        this._canvas = document.createElement('canvas');
        this._canvas.width = 1920;
        this._canvas.height = 1080;
        this._ctx = this._canvas.getContext('2d', { willReadFrequently: false });
    }

    /**
     * Render a motion graphic for the given local frame.
     * Returns a TextureManager entry { texture, width, height } or null.
     *
     * @param {object} mg - MG spec object from video-plan.json
     * @param {number} localFrame - Frame number relative to MG start (0 = first frame)
     * @param {object} scriptContext - Script context from plan (for theme)
     */
    renderMG(mg, localFrame, scriptContext) {
        const ctx = this._ctx;
        ctx.clearRect(0, 0, 1920, 1080);

        const s = this._getStyle(mg, scriptContext);
        const anim = AnimationUtils.computeAnimationState(localFrame, this.fps, {
            ...mg,
            _animationSpeed: mg._animationSpeed || 1.0,
        });

        let rendered = false;
        switch (mg.type) {
            case 'headline':
                this._renderHeadline(ctx, localFrame, this.fps, mg, s, anim);
                rendered = true;
                break;
            case 'lowerThird':
                this._renderLowerThird(ctx, localFrame, this.fps, mg, s, anim);
                rendered = true;
                break;
            case 'callout':
                this._renderCallout(ctx, localFrame, this.fps, mg, s, anim);
                rendered = true;
                break;
            default:
                // Fallback: render any unknown MG type as a headline so text is visible
                if (mg.text) {
                    this._renderHeadline(ctx, localFrame, this.fps, mg, s, anim);
                    rendered = true;
                }
                break;
        }

        if (!rendered) return null;

        // Upload the canvas to a WebGL texture
        const texId = `mg-${mg.type}-${mg._startFrame || 0}`;
        return this.textureManager.createOrUpdate(texId, this._canvas);
    }

    // ========================================================================
    // STYLE RESOLUTION (mirrors the app.js getStyledThemeColors + MG_STYLES)
    // ========================================================================

    _getStyle(mg, scriptContext) {
        const styleName = mg.style || 'clean';
        // Use the global MG_STYLES from app.js (already in scope)
        const baseS = (typeof MG_STYLES !== 'undefined' ? MG_STYLES[styleName] : null) || {
            primary: '#3b82f6', accent: '#f59e0b', bg: 'rgba(0,0,0,0.7)',
            text: '#ffffff', textSub: 'rgba(255,255,255,0.75)', glow: false,
        };

        // Try to get theme-styled colors (uses app.js globals)
        let styled = null;
        if (typeof getStyledThemeColors === 'function') {
            styled = getStyledThemeColors(styleName);
        }
        const s = styled ? { ...baseS, ...styled } : { ...baseS };

        // Get theme fonts
        if (typeof getActiveThemeFonts === 'function') {
            const tf = getActiveThemeFonts();
            if (tf) {
                s.fontHeading = tf.heading.replace(/"/g, "'");
                s.fontBody = tf.body.replace(/"/g, "'");
            }
        }
        if (!s.fontHeading) s.fontHeading = 'Arial, sans-serif';
        if (!s.fontBody) s.fontBody = 'Arial, sans-serif';

        return s;
    }

    // ========================================================================
    // POSITION HELPERS (ported from canvas-mg-renderer.js)
    // ========================================================================

    // Positions matched to CSS preview: bottom-left=padding 0 0 8% 4%, top=5%, center-left=5%
    static CANVAS_POS = {
        'center':       { anchorX: 0.5, anchorY: 0.5, padX: 0, padY: 0 },
        'bottom-left':  { anchorX: 0, anchorY: 1, padX: 77, padY: -86 },
        'bottom-right': { anchorX: 1, anchorY: 1, padX: -77, padY: -86 },
        'top':          { anchorX: 0.5, anchorY: 0, padX: 0, padY: 54 },
        'center-left':  { anchorX: 0, anchorY: 0.5, padX: 96, padY: 0 },
        'top-left':     { anchorX: 0, anchorY: 0, padX: 77, padY: 54 },
    };

    static _getPosXY(position, contentW, contentH) {
        const a = MGRenderer.CANVAS_POS[position] || MGRenderer.CANVAS_POS['center'];
        const x = a.anchorX * 1920 + a.padX - a.anchorX * contentW;
        const y = a.anchorY * 1080 + a.padY - a.anchorY * contentH;
        return { x, y };
    }

    // ========================================================================
    // DRAWING HELPERS (ported from canvas-mg-renderer.js)
    // ========================================================================

    static _setFont(ctx, weight, size, family) {
        const fam = (family || 'Arial, sans-serif').replace(/"/g, "'");
        ctx.font = `${weight} ${size}px ${fam}`;
    }

    static _drawTextShadowed(ctx, text, x, y, s, strong) {
        if (s.glow) {
            ctx.shadowColor = strong ? 'rgba(0,0,0,0.9)' : 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = strong ? 12 : 8;
            ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 2;
            ctx.fillText(text, x, y);
            ctx.shadowColor = s.primary + (strong ? '90' : '60');
            ctx.shadowBlur = strong ? 30 : 20;
            ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
            ctx.fillText(text, x, y);
            ctx.shadowColor = s.primary + (strong ? '40' : '25');
            ctx.shadowBlur = strong ? 60 : 40;
            ctx.fillText(text, x, y);
        } else {
            ctx.shadowColor = strong ? 'rgba(0,0,0,0.85)' : 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = strong ? 24 : 12;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = strong ? 4 : 2;
            ctx.fillText(text, x, y);
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

    static _drawGradientRect(ctx, x, y, w, h, color1, color2, direction) {
        if (!direction) direction = 'horizontal';
        const grad = direction === 'horizontal'
            ? ctx.createLinearGradient(x, y, x + w, y)
            : ctx.createLinearGradient(x, y, x, y + h);
        grad.addColorStop(0, color1);
        grad.addColorStop(1, color2);
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, w, h);
    }

    // ========================================================================
    // HEADLINE RENDERER (ported from canvas-mg-renderer.js renderHeadline)
    // ========================================================================

    _renderHeadline(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const { enterSpring, enterLinear, isExiting, exitProgress, opacity, idleScale, speed } = anim;

        const scale = isExiting
            ? interpolate(exitProgress, [0, 1], [0.97, 1])
            : interpolate(enterSpring, [0, 1], [0.88, 1]);
        const translateY = isExiting
            ? interpolate(exitProgress, [0, 1], [-12, 0])
            : interpolate(enterSpring, [0, 1], [30, 0]);
        const blur = isExiting ? 0 : interpolate(enterLinear, [0, 0.6], [6, 0], { extrapolateRight: 'clamp' });

        // Accent bar — delay 0.25s, damping 20, duration 0.3s
        const barDelay = Math.round((0.25 / speed) * fps);
        const barSpring = springValue(Math.max(0, frame - barDelay), fps, {
            damping: 20, stiffness: 100, durationInFrames: Math.round((0.3 / speed) * fps),
        });
        const barWidth = barSpring * 300;

        // Subtext — delay 0.2s, damping 18
        const subDelay = Math.round(0.2 * fps);
        const subSpring = springValue(Math.max(0, frame - subDelay), fps, { damping: 18, stiffness: 100 });
        const subOpacity = isExiting ? exitProgress : subSpring;

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        // Position — adapt alignment to avoid clipping off canvas edges
        const position = mg.position || 'center';
        const isLeft = position.includes('left');
        const isRight = position.includes('right');

        // Measure text to get actual width
        MGRenderer._setFont(ctx, '900', 72, s.fontHeading);
        const textW = ctx.measureText(mg.text || '').width;
        const contentW = Math.max(800, textW + 40);
        const pos = MGRenderer._getPosXY(position, contentW, 200);

        let cx, textAlign, textX, barX;
        if (isLeft) {
            cx = pos.x + 20;  // left edge with padding
            textAlign = 'left';
            textX = 0;
            barX = 0;
        } else if (isRight) {
            cx = pos.x + contentW - 20;
            textAlign = 'right';
            textX = 0;
            barX = -barWidth;
        } else {
            cx = pos.x + contentW / 2;
            textAlign = 'center';
            textX = 0;
            barX = -barWidth / 2;
        }
        const cy = pos.y + 100;

        ctx.translate(cx, cy + translateY);
        ctx.scale(scale * idleScale, scale * idleScale);

        if (blur > 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`;

        // Main text
        ctx.fillStyle = s.text;
        ctx.textAlign = textAlign;
        ctx.textBaseline = 'middle';
        MGRenderer._drawTextShadowed(ctx, mg.text || '', textX, -30, s, true);

        ctx.filter = 'none';

        // Accent bar
        if (barWidth > 1) {
            MGRenderer._drawGradientRect(ctx, barX, 15, barWidth, 4, s.primary, s.accent);
        }

        // Subtext
        if (mg.subtext && subOpacity > 0.01) {
            ctx.globalAlpha = Math.min(1, opacity) * subOpacity;
            MGRenderer._setFont(ctx, '500', 26, s.fontBody);
            ctx.fillStyle = s.accent;
            ctx.textAlign = textAlign;
            MGRenderer._drawTextShadowed(ctx, mg.subtext, textX, 50, s, false);
        }

        ctx.restore();
    }

    // ========================================================================
    // LOWER THIRD RENDERER (ported from canvas-mg-renderer.js)
    // ========================================================================

    _renderLowerThird(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const { enterSpring, enterLinear, isExiting, exitProgress, opacity, idleScale, speed } = anim;

        const clipAmount = interpolate(enterSpring, [0, 1], [0, 100]);
        const barScaleY = springValue(Math.max(0, frame - Math.round((0.15 / speed) * fps)), fps, {
            damping: 20, stiffness: 120, durationInFrames: Math.round((0.35 / speed) * fps),
        });

        const textDelay = Math.round((0.2 / speed) * fps);
        const textSpring = springValue(Math.max(0, frame - textDelay), fps, {
            damping: 18, stiffness: 100, durationInFrames: Math.round((0.3 / speed) * fps),
        });
        const textSlideX = interpolate(textSpring, [0, 1], [-15, 0]);

        const subDelay = Math.round((0.35 / speed) * fps);
        const subSpring = springValue(Math.max(0, frame - subDelay), fps, { damping: 18, stiffness: 100 });

        ctx.save();
        ctx.globalAlpha = Math.min(1, isExiting ? exitProgress : opacity);

        // Position at bottom-left
        const baseX = 60;
        const baseY = 1080 - 200;

        // Clip-path reveal (horizontal wipe from left)
        ctx.beginPath();
        ctx.rect(baseX, baseY - 20, 700 * (clipAmount / 100), 200);
        ctx.clip();

        // Vertical accent bar
        const accentH = 120 * barScaleY;
        MGRenderer._drawGradientRect(ctx, baseX, baseY + 60 - accentH / 2, 4, accentH, s.primary, s.accent, 'vertical');

        // Main text
        MGRenderer._setFont(ctx, '700', 36, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.globalAlpha = Math.min(1, opacity) * textSpring;
        MGRenderer._drawTextShadowed(ctx, mg.text || '', baseX + 20 + textSlideX, baseY + 20, s, true);

        // Subtext
        if (mg.subtext) {
            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : subSpring);
            MGRenderer._setFont(ctx, '500', 22, s.fontBody);
            ctx.fillStyle = s.accent;
            MGRenderer._drawTextShadowed(ctx, mg.subtext, baseX + 20, baseY + 65, s, false);
        }

        ctx.restore();
    }

    // ========================================================================
    // CALLOUT RENDERER (ported from canvas-mg-renderer.js)
    // ========================================================================

    _renderCallout(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const { enterSpring, enterLinear, isExiting, exitProgress, opacity, idleScale, speed } = anim;

        const scale = isExiting
            ? interpolate(exitProgress, [0, 1], [0.97, 1])
            : interpolate(enterSpring, [0, 1], [0.92, 1]);
        const blur = isExiting ? 0 : interpolate(enterLinear, [0, 0.5], [3, 0], { extrapolateRight: 'clamp' });

        const quoteDelay = Math.round((0.1 / speed) * fps);
        const quoteSpring = springValue(Math.max(0, frame - quoteDelay), fps, {
            damping: 16, stiffness: 100, durationInFrames: Math.round((0.3 / speed) * fps),
        });
        const quoteY = interpolate(quoteSpring, [0, 1], [-15, 0]);

        ctx.save();
        ctx.globalAlpha = Math.min(1, isExiting ? exitProgress : opacity);

        // Measure text to size box
        MGRenderer._setFont(ctx, '600', 34, s.fontHeading);
        const textWidth = Math.min(ctx.measureText(mg.text || '').width + 80, 1920 * 0.7);
        const boxW = Math.max(400, textWidth);
        const boxH = mg.subtext ? 160 : 120;
        const pos = MGRenderer._getPosXY(mg.position || 'center', boxW, boxH);

        ctx.translate(pos.x + boxW / 2, pos.y + boxH / 2);
        ctx.scale(scale * idleScale, scale * idleScale);
        if (blur > 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`;

        // Background box
        if (s.glow) {
            ctx.shadowColor = s.primary + '30';
            ctx.shadowBlur = 10;
        } else {
            ctx.shadowColor = 'rgba(0,0,0,0.4)';
            ctx.shadowBlur = 16;
            ctx.shadowOffsetY = 4;
        }
        MGRenderer._roundRect(ctx, -boxW / 2, -boxH / 2, boxW, boxH, 12);
        ctx.fillStyle = s.bg;
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
        ctx.strokeStyle = s.primary;
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.filter = 'none';

        // Quote mark
        ctx.globalAlpha = Math.min(1, opacity) * quoteSpring * 0.6;
        MGRenderer._setFont(ctx, '900', 64, s.fontHeading);
        ctx.fillStyle = s.primary;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('\u201C', -boxW / 2 + 20, -boxH / 2 - 24 + quoteY);

        // Main text (italic)
        ctx.globalAlpha = Math.min(1, isExiting ? exitProgress : opacity);
        MGRenderer._setFont(ctx, 'italic 600', 34, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        MGRenderer._drawTextShadowed(ctx, mg.text || '', 0, mg.subtext ? -15 : 0, s, false);

        // Attribution
        if (mg.subtext) {
            MGRenderer._setFont(ctx, '500', 20, s.fontBody);
            ctx.fillStyle = s.textSub || 'rgba(255,255,255,0.75)';
            ctx.fillText(`\u2014 ${mg.subtext}`, 0, boxH / 2 - 30);
        }

        ctx.restore();
    }

    // ========================================================================
    // ROUND RECT HELPER
    // ========================================================================

    static _roundRect(ctx, x, y, w, h, r) {
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

    /**
     * Cleanup resources.
     */
    destroy() {
        this._canvas = null;
        this._ctx = null;
    }
}

window.MGRenderer = MGRenderer;
