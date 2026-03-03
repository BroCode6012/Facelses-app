/**
 * YTA Empire 2 - UI Application
 * FIXED: Playhead - freely draggable, can go to 0, doesn't disappear when panning
 */

// ========================================
// MG Style Themes (must match MotionGraphics.jsx STYLES)
// ========================================
const MG_STYLES = {
    clean:    { primary: '#3b82f6', accent: '#f59e0b', bg: 'rgba(0,0,0,0.7)',    text: '#ffffff', textSub: 'rgba(255,255,255,0.75)', glow: false },
    bold:     { primary: '#ef4444', accent: '#fbbf24', bg: 'rgba(10,10,10,0.92)', text: '#ffffff', textSub: 'rgba(255,255,255,0.85)', glow: false },
    minimal:  { primary: '#e5e7eb', accent: '#94a3b8', bg: 'rgba(0,0,0,0.35)',    text: '#f8fafc', textSub: 'rgba(255,255,255,0.5)',  glow: false },
    neon:     { primary: '#00ff88', accent: '#ff00ff', bg: 'rgba(0,0,15,0.85)',   text: '#ffffff', textSub: 'rgba(255,255,255,0.7)',  glow: true  },
    cinematic:{ primary: '#d4af37', accent: '#c0c0c0', bg: 'rgba(0,0,0,0.92)',    text: '#f5f0e8', textSub: 'rgba(245,240,232,0.55)', glow: false },
    elegant:  { primary: '#8b5cf6', accent: '#f472b6', bg: 'rgba(10,0,25,0.82)',  text: '#ffffff', textSub: 'rgba(255,255,255,0.6)',  glow: true  },
};

// ========================================
// Theme Fonts (must match src/themes.js)
// Maps themeId → font families for MG preview
// ========================================
const THEME_FONTS = {
    tech:      { heading: 'Orbitron, Electrolize, "Courier New", monospace',      body: '"Roboto Mono", "Source Code Pro", monospace' },
    nature:    { heading: '"Libre Baskerville", Merriweather, Georgia, serif',     body: 'Lora, "Open Sans", Georgia, sans-serif' },
    crime:     { heading: 'Oswald, "Bebas Neue", Impact, sans-serif',             body: '"Barlow Condensed", Lato, Arial, sans-serif' },
    corporate: { heading: 'Montserrat, "Work Sans", Arial, sans-serif',           body: '"Source Sans Pro", "Open Sans", "Segoe UI", sans-serif' },
    luxury:    { heading: '"Playfair Display", Cinzel, Georgia, serif',            body: 'Lora, "Libre Baskerville", "Times New Roman", serif' },
    sport:     { heading: '"Bebas Neue", "Fjalla One", Impact, sans-serif',        body: '"Roboto Condensed", "Barlow Condensed", Arial, sans-serif' },
    neutral:   { heading: 'Nunito, Raleway, Arial, sans-serif',                    body: '"Open Sans", Roboto, Arial, sans-serif' },
};

// Theme colors (base palette per theme)
const THEME_COLORS = {
    tech:      { primary: '#00ffff', accent: '#00ff00', text: '#ffffff', textSub: 'rgba(255,255,255,0.7)' },
    nature:    { primary: '#8B4513', accent: '#87CEEB', text: '#ffffff', textSub: 'rgba(255,255,255,0.7)' },
    crime:     { primary: '#dc143c', accent: '#ffd700', text: '#ffffff', textSub: 'rgba(255,255,255,0.7)' },
    corporate: { primary: '#0066cc', accent: '#00cc66', text: '#ffffff', textSub: 'rgba(255,255,255,0.7)' },
    luxury:    { primary: '#d4af37', accent: '#c0c0c0', text: '#ffffff', textSub: 'rgba(255,255,255,0.6)' },
    sport:     { primary: '#ff4500', accent: '#00ff00', text: '#ffffff', textSub: 'rgba(255,255,255,0.8)' },
    neutral:   { primary: '#4a90e2', accent: '#e74c3c', text: '#ffffff', textSub: 'rgba(255,255,255,0.7)' },
};

// Style modifiers — each MG style transforms colors so they stay visually distinct
const MG_STYLE_MODIFIERS = {
    clean:     { saturate: 1.0, brighten: 0,   tintHue: null },
    bold:      { saturate: 1.3, brighten: 15,  tintHue: null },
    minimal:   { saturate: 0.4, brighten: 40,  tintHue: null },
    neon:      { saturate: 1.6, brighten: 50,  tintHue: null },
    cinematic: { saturate: 0.8, brighten: -10, tintHue: 40  },
    elegant:   { saturate: 1.1, brighten: 10,  tintHue: 280 },
};

function _hexToHSL(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    const r = parseInt(hex.substring(0,2), 16) / 255;
    const g = parseInt(hex.substring(2,4), 16) / 255;
    const b = parseInt(hex.substring(4,6), 16) / 255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    let h = 0, s = 0, l = (max+min)/2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = ((g-b)/d + (g<b?6:0)) / 6;
        else if (max === g) h = ((b-r)/d + 2) / 6;
        else h = ((r-g)/d + 4) / 6;
    }
    return { h: h*360, s: s*100, l: l*100 };
}

function _hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(100, s)) / 100;
    l = Math.max(0, Math.min(100, l)) / 100;
    const a = s * Math.min(l, 1-l);
    const f = n => { const k = (n + h/30) % 12; return l - a * Math.max(-1, Math.min(k-3, 9-k, 1)); };
    const toH = x => Math.round(x*255).toString(16).padStart(2,'0');
    return `#${toH(f(0))}${toH(f(8))}${toH(f(4))}`;
}

function applyMGStyleModifier(color, mod) {
    try {
        const hsl = _hexToHSL(color);
        let { h, s, l } = hsl;
        s = Math.min(100, s * mod.saturate);
        l = Math.max(5, Math.min(95, l + mod.brighten));
        if (mod.tintHue !== null) h = h * 0.5 + mod.tintHue * 0.5;
        return _hslToHex(h, s, l);
    } catch { return color; }
}

/**
 * Get themed+styled colors for MG preview.
 * Applies style modifier to theme colors so each MG style looks distinct.
 */
function getStyledThemeColors(styleName) {
    const themeColors = getActiveThemeColors();
    if (!themeColors) return null; // no theme, use MG_STYLES defaults
    const mod = MG_STYLE_MODIFIERS[styleName] || MG_STYLE_MODIFIERS.clean;
    return {
        ...themeColors,
        primary: applyMGStyleModifier(themeColors.primary, mod),
        accent: applyMGStyleModifier(themeColors.accent, mod),
    };
}

/**
 * Get active theme fonts and colors for MG preview
 * Uses the theme dropdown selection OR the plan's scriptContext.themeId
 */
function getActiveThemeFonts() {
    // Check theme dropdown
    const themeEl = document.getElementById('build-theme');
    const themeId = themeEl ? themeEl.value : 'auto';

    // If 'auto', check if the loaded plan has a themeId
    let activeTheme = themeId;
    if (activeTheme === 'auto' && state.videoPlan && state.videoPlan.scriptContext) {
        activeTheme = state.videoPlan.scriptContext.themeId || 'neutral';
    }

    if (activeTheme === 'auto' || !THEME_FONTS[activeTheme]) {
        return { heading: 'Arial, sans-serif', body: 'Arial, sans-serif' };
    }

    return THEME_FONTS[activeTheme];
}

function getActiveThemeColors() {
    const themeEl = document.getElementById('build-theme');
    const themeId = themeEl ? themeEl.value : 'auto';

    let activeTheme = themeId;
    if (activeTheme === 'auto' && state.videoPlan && state.videoPlan.scriptContext) {
        activeTheme = state.videoPlan.scriptContext.themeId || null;
    }

    if (!activeTheme || activeTheme === 'auto' || !THEME_COLORS[activeTheme]) {
        return null; // Use MG_STYLES defaults
    }

    return THEME_COLORS[activeTheme];
}

function parseKeyValuePairs(subtext) {
    if (!subtext || subtext === 'none') return [];
    const raw = subtext.split(',').map(s => s.trim()).filter(Boolean);
    const results = [];
    for (const part of raw) {
        const colonIdx = part.indexOf(':');
        if (colonIdx !== -1) {
            // New key:value pair
            results.push({ label: part.substring(0, colonIdx).trim(), value: part.substring(colonIdx + 1).trim() });
        } else if (results.length > 0 && /^\d+$/.test(part.trim())) {
            // Orphaned numeric fragment (e.g. "000" from "900,000") — merge back into previous value
            results[results.length - 1].value += ',' + part.trim();
        } else if (part.trim()) {
            results.push({ label: part.trim(), value: '0' });
        }
    }
    return results;
}

// ========================================
// State Management
// ========================================
const state = {
    audioFile: null,
    audioPath: null,
    scenes: [],
    isProcessing: false,
    videoPlan: null,
    hasProjectFile: false, // True once a .fvp file exists (enables auto-save)
    currentSceneIndex: 0,
    activeSceneIndices: [], // Active media scene indices (non-overlay, non-MG)
    activeOverlaySceneIndices: [], // Active overlay scene indices
    _mediaUrlCache: {}, // Cache: sceneIndex+ext → mediaUrl (avoids repeated IPC calls)
    _trackActiveEl: { '1': 'a', '2': 'a', '3': 'a' }, // Double-buffer: which element ('a' or 'b') is active per track
    _trackSwapPending: { '1': false, '2': false, '3': false }, // Per-track: deferred swap in progress
    _trackLastHardSyncMs: { '1': 0, '2': 0, '3': 0 }, // Last forced seek time per track (prevents seek thrash)
    _lastPreloadCheck: 0, // Throttle preload checks
    _sceneLoadPending: false, // True while loadActiveScenes is running
    isPlaying: false,
    currentTime: 0,
    totalDuration: 0,
    playbackAnimationFrame: null,
    lastPlaybackTime: 0,
    snapEnabled: true,
    snapThreshold: 10, // pixels
    // Undo/Redo history
    undoStack: [],
    redoStack: [],
    maxUndoLevels: 50,
    // Clipboard for copy/paste
    clipboard: null,
    selectedClipIndex: -1,
    selectedClipIndices: [], // Multi-select: array of selected clip indices
    selectedMgIndex: -1, // Selected motion graphic index
    // Audio clip offset (for dragging audio along timeline)
    audioClipOffset: 0,
    audioClipTrack: 'audio-track',
    // Preview zoom ('fit' or number like 25, 50, 100, 200)
    previewZoom: 'fit',
    // Transition system - disabled (hard cut only)
    transition: {
        style: 'cut',
        duration: 0,
        isTransitioning: false,
        activeVideoIndex: 0,
        types: [],
        metadata: { cut: { name: 'Cut', icon: '✂', description: 'Instant cut' } }
    },
    volume: 1,
    isMuted: false,
    mutedTracks: {}, // { 'video-track-1': true, 'audio-track': true, ... }
    // Available overlays scanned from assets/overlays/
    availableOverlays: [], // [{ filename, name, ext, mediaType, size, path }]
    // Available backgrounds scanned from assets/backgrounds/
    availableBackgrounds: [], // [{ filename, name, ext, mediaType, size, path }]
    // SFX system - auto-placed at transition points
    sfxClips: [],
    sfxEnabled: true,
    sfxVolume: 0.35,
    _sfxAudioPool: [],
    // Motion Graphics system - AI-placed text overlays
    motionGraphics: [],
    mgEnabled: true,
    subtitlesEnabled: false,
    mgStyle: 'clean',
    aiInstructions: '',
    timeline: {
        zoom: 50,
        scrollX: 0,
        minZoom: 0.5,
        maxZoom: 200,
        isDraggingPlayhead: false,
        tracks: [
            { id: 'video-track-3', label: 'V3', type: 'video' },
            { id: 'video-track-2', label: 'V2', type: 'video' },
            { id: 'video-track-1', label: 'V1', type: 'video', main: true },
            { id: 'mg-track', label: 'MG', type: 'graphics' },
            { id: 'audio-track', label: 'VO', type: 'audio' },
            { id: 'music-track', label: 'MUS', type: 'audio' },
            { id: 'sfx-track', label: 'SFX', type: 'audio' }
        ],
        trackHeights: {
            'video-track-3': 28, 'video-track-2': 28, 'video-track-1': 40,
            'mg-track': 32,
            'audio-track': 36, 'music-track': 28, 'sfx-track': 22
        },
        trackMinHeights: {
            'video-track-3': 22, 'video-track-2': 22, 'video-track-1': 28,
            'mg-track': 22,
            'audio-track': 26, 'music-track': 22, 'sfx-track': 18
        },
        trackMaxHeights: {
            'video-track-3': 120, 'video-track-2': 120, 'video-track-1': 120,
            'mg-track': 80,
            'audio-track': 80, 'music-track': 80, 'sfx-track': 60
        }
    },
    // WebGL2 Compositor Engine state
    compositor: null,           // Compositor instance
    compositorActive: false,    // Whether compositor preview is active
};

const TRACK_HEADER_WIDTH = 100;

// ========================================
// Built-in gradient backgrounds (mirrors BACKGROUND_LIBRARY from themes.js)
// ========================================
const GRADIENT_BACKGROUNDS = {
    'dark-gradient':  'radial-gradient(ellipse at 50% 40%, #1a1a2e 0%, #0a0a14 60%, #000000 100%)',
    'blue-minimal':   'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    'dark-blue':      'radial-gradient(ellipse at 50% 50%, #0f2027 0%, #203a43 40%, #2c5364 100%)',
    'green-gradient': 'linear-gradient(160deg, #0f3443 0%, #34e89e 100%)',
    'warm-sunset':    'linear-gradient(135deg, #f093fb 0%, #f5576c 50%, #fda085 100%)',
    'midnight':       'radial-gradient(ellipse at 30% 50%, #1a0a2e 0%, #0a0014 50%, #000000 100%)',
    'cream':          'linear-gradient(180deg, #fdf6e3 0%, #ede0c8 50%, #d4c5a9 100%)',
    'grid-texture':   'repeating-linear-gradient(0deg, transparent, transparent 49px, rgba(255,255,255,0.03) 49px, rgba(255,255,255,0.03) 50px), repeating-linear-gradient(90deg, transparent, transparent 49px, rgba(255,255,255,0.03) 49px, rgba(255,255,255,0.03) 50px), linear-gradient(135deg, #0a0a1a 0%, #1a1a2e 100%)',
    'red-dark':       'radial-gradient(ellipse at 50% 50%, #2a0a0a 0%, #1a0505 50%, #0a0000 100%)',
    'purple-haze':    'linear-gradient(135deg, #667eea 0%, #764ba2 50%, #3a1c71 100%)',
    'noir':           'radial-gradient(ellipse at 50% 30%, #1a1a1a 0%, #0a0a0a 40%, #000000 100%)',
    'ocean-deep':     'linear-gradient(180deg, #0c3547 0%, #0a2a3a 40%, #051a2a 100%)',
};

const GRADIENT_BACKGROUND_NAMES = {
    'dark-gradient': 'Dark Gradient',  'blue-minimal': 'Blue Minimal',
    'dark-blue': 'Dark Blue',          'green-gradient': 'Green Gradient',
    'warm-sunset': 'Warm Sunset',      'midnight': 'Midnight',
    'cream': 'Cream',                  'grid-texture': 'Grid Texture',
    'red-dark': 'Red Dark',            'purple-haze': 'Purple Haze',
    'noir': 'Noir',                    'ocean-deep': 'Ocean Deep',
};

// ========================================
// DOM Elements
// ========================================
const elements = {
    btnNew: document.getElementById('btn-new'),
    btnOpenProject: document.getElementById('btn-open-project'),
    projectNameLabel: document.getElementById('project-name-label'),
    btnRefresh: document.getElementById('btn-refresh'),
    btnRender: document.getElementById('btn-render'),
    btnGenerate: document.getElementById('btn-generate'),
    btnRemoveAudio: document.getElementById('btn-remove-audio'),
    dropZone: document.getElementById('drop-zone'),
    fileInput: document.getElementById('file-input'),
    audioInfo: document.getElementById('audio-info'),
    audioName: document.getElementById('audio-name'),
    aiProvider: document.getElementById('ai-provider'),
    ollamaModelRow: document.getElementById('ollama-model-row'),
    ollamaModel: document.getElementById('ollama-model'),
    ollamaVisionModel: document.getElementById('ollama-vision-model'),
    aiInstructions: document.getElementById('ai-instructions'),
    buildQuality: document.getElementById('build-quality'),
    buildFormat: document.getElementById('build-format'),
    buildTheme: document.getElementById('build-theme'),
    // Footage source toggles
    srcPexels: document.getElementById('src-pexels'),
    srcPixabay: document.getElementById('src-pixabay'),
    srcYouTube: document.getElementById('src-youtube'),
    srcNewsVideo: document.getElementById('src-news-video'),
    srcUnsplash: document.getElementById('src-unsplash'),
    srcGoogleCSE: document.getElementById('src-google-cse'),
    srcBing: document.getElementById('src-bing'),
    srcDuckDuckGo: document.getElementById('src-duckduckgo'),
    srcGoogleScrape: document.getElementById('src-google-scrape'),
    transitionStyle: document.getElementById('transition-style'),
    previewPlaceholder: document.getElementById('preview-placeholder'),
    // Multi-track video system
    videoContainer: document.getElementById('video-transition-container'),
    videoTrack1: document.getElementById('video-track-1'),
    videoTrack2: document.getElementById('video-track-2'),
    videoTrack3: document.getElementById('video-track-3'),
    videoTrack1B: document.getElementById('video-track-1-b'),
    videoTrack2B: document.getElementById('video-track-2-b'),
    videoTrack3B: document.getElementById('video-track-3-b'),
    videoTransitionOut: document.getElementById('video-transition-out'),
    // Image track elements (for image scenes)
    imgTrack1: document.getElementById('img-track-1'),
    imgTrack2: document.getElementById('img-track-2'),
    imgTrack3: document.getElementById('img-track-3'),
    imgTransitionOut: document.getElementById('img-transition-out'),
    // Motion Graphics overlay
    mgOverlay: document.getElementById('mg-overlay'),
    // Video controls
    videoControls: document.getElementById('video-controls'),
    btnPlay: document.getElementById('btn-play'),
    btnMute: document.getElementById('btn-mute'),
    btnFullscreen: document.getElementById('btn-fullscreen'),
    volumeSlider: document.getElementById('volume-slider'),
    currentTimeDisplay: document.getElementById('current-time-display'),
    totalTimeDisplay: document.getElementById('total-time-display'),
    // Audio
    previewAudio: document.getElementById('preview-audio'),
    progressContainer: document.getElementById('progress-container'),
    progressFill: document.getElementById('progress-fill'),
    progressText: document.getElementById('progress-text'),
    progressTimer: document.getElementById('progress-timer'),
    btnCancel: document.getElementById('btn-cancel'),
    sceneList: document.getElementById('scene-list'),
    timelineContainer: document.getElementById('timeline-container'),
    leftPanel: document.getElementById('left-panel'),
    rightPanel: document.getElementById('right-panel'),
    resizeLeft: document.getElementById('resize-left'),
    resizeRight: document.getElementById('resize-right'),
    resizeTimeline: document.getElementById('resize-timeline'),
    // Clip properties panel
    clipProperties: document.getElementById('clip-properties'),
    propScale: document.getElementById('prop-scale'),
    propPosX: document.getElementById('prop-pos-x'),
    propPosY: document.getElementById('prop-pos-y'),
    propScaleVal: document.getElementById('prop-scale-val'),
    propPosXVal: document.getElementById('prop-pos-x-val'),
    propPosYVal: document.getElementById('prop-pos-y-val'),
    propVolume: document.getElementById('prop-volume'),
    propVolumeVal: document.getElementById('prop-volume-val'),
    propBackground: document.getElementById('prop-background'),
    propFitMode: document.getElementById('prop-fit-mode'),
    propAnimate: document.getElementById('prop-animate'),
    propAnimateRow: document.getElementById('prop-animate-row'),
    propReset: document.getElementById('prop-reset'),
    propCropTop: document.getElementById('prop-crop-top'),
    propCropBottom: document.getElementById('prop-crop-bottom'),
    propCropLeft: document.getElementById('prop-crop-left'),
    propCropRight: document.getElementById('prop-crop-right'),
    propCropTopVal: document.getElementById('prop-crop-top-val'),
    propCropBottomVal: document.getElementById('prop-crop-bottom-val'),
    propCropLeftVal: document.getElementById('prop-crop-left-val'),
    propCropRightVal: document.getElementById('prop-crop-right-val'),
    propBorderRadius: document.getElementById('prop-border-radius'),
    propBorderRadiusVal: document.getElementById('prop-border-radius-val'),
    // Track wrappers (for crop/radius)
    trackWrapper1: document.getElementById('track-wrapper-1'),
    trackWrapper2: document.getElementById('track-wrapper-2'),
    trackWrapper3: document.getElementById('track-wrapper-3'),
    // Background layer elements
    bgVideo: document.getElementById('bg-video'),
    bgImage: document.getElementById('bg-image'),
    bgGradient: document.getElementById('bg-gradient'),
    // Preview zoom
    previewContainer: document.getElementById('preview-container'),
    previewZoomSelect: document.getElementById('preview-zoom-select'),
    previewZoomLabel: document.getElementById('preview-zoom-label'),
    // SFX controls
    sfxEnabled: document.getElementById('sfx-enabled'),
    sfxVolume: document.getElementById('sfx-volume'),
    sfxVolumeLabel: document.getElementById('sfx-volume-label'),
    // Motion Graphics controls
    mgEnabled: document.getElementById('mg-enabled'),
    // Subtitles
    subtitlesEnabled: document.getElementById('subtitles-enabled'),
};

// ========================================
// Multi-Track Helper Functions
// ========================================

/**
 * Double-buffer helpers: each track has two video elements (A and B).
 * While one plays, the other preloads the next clip.
 * Switching is instant — just toggle visibility.
 */
function getTrackVideoPair(trackNum) {
    const which = state._trackActiveEl[trackNum] || 'a';
    const a = elements[`videoTrack${trackNum}`];
    const b = elements[`videoTrack${trackNum}B`];
    return {
        active: which === 'a' ? a : b,
        buffer: which === 'a' ? b : a,
    };
}

function swapTrackActive(trackNum) {
    state._trackActiveEl[trackNum] = state._trackActiveEl[trackNum] === 'a' ? 'b' : 'a';
}

function getActiveTrackVideo(trackNum) {
    const which = state._trackActiveEl[trackNum] || 'a';
    if (which === 'a') return elements[`videoTrack${trackNum}`];
    return elements[`videoTrack${trackNum}B`];
}

/**
 * Get all scenes active at a given time across all tracks
 * @param {number} time - Time in seconds
 * @returns {Array<{scene, index}>} - Array of active scenes sorted by track
 */
function getActiveScenesAtTime(time) {
    return state.scenes
        .map((scene, index) => ({ scene, index }))
        .filter(({ scene }) => time >= scene.startTime && time < scene.endTime)
        .sort((a, b) => {
            // Sort by track (lower track number = render first/below)
            const trackA = parseInt(a.scene.trackId?.match(/\d+/)?.[0] || '1');
            const trackB = parseInt(b.scene.trackId?.match(/\d+/)?.[0] || '1');
            return trackA - trackB;
        });
}

// ========================================
// Initialize
// ========================================
async function init() {
    // Add error handlers on video elements to catch loading failures (A and B buffers)
    [elements.videoTrack1, elements.videoTrack2, elements.videoTrack3,
     elements.videoTrack1B, elements.videoTrack2B, elements.videoTrack3B].forEach((video, i) => {
        if (!video) return;
        const label = i < 3 ? `Track ${i + 1}A` : `Track ${i - 2}B`;
        video.addEventListener('error', (e) => {
            const err = video.error;
            console.error(`[Video ${label}] Error: code=${err?.code} message=${err?.message} src=${video.src?.substring(video.src.lastIndexOf('/') + 1)}`);
        });
        video.addEventListener('stalled', () => {
            console.warn(`[Video ${label}] Stalled: src=${video.src?.substring(video.src.lastIndexOf('/') + 1)} readyState=${video.readyState}`);
        });
    });

    // Load and display project info
    loadProjectInfo();

    setupEventListeners();
    setupElectronListeners();
    setupKeyboardShortcuts();
    setupResizablePanels();
    setupPanelSections();
    setupVideoControls();
    setupClipPropertyListeners();
    setupMgPropertyListeners();
    setupPreviewDrag();
    setupPreviewZoom();
    setupNotifCenter();
    loadSettings();
    // Show Ollama model row if Ollama is the active provider
    if (elements.ollamaModelRow) {
        elements.ollamaModelRow.style.display = elements.aiProvider.value === 'ollama' ? 'block' : 'none';
    }

    // Scan available overlays from assets/overlays/
    try {
        state.availableOverlays = await window.electronAPI.scanOverlays();
        console.log(`📁 Found ${state.availableOverlays.length} overlay files in assets/overlays/`);
    } catch (e) {
        console.log('Could not scan overlays folder:', e.message);
        state.availableOverlays = [];
    }

    // Scan available backgrounds from assets/backgrounds/
    try {
        state.availableBackgrounds = await window.electronAPI.scanBackgrounds();
        console.log(`📁 Found ${state.availableBackgrounds.length} background files in assets/backgrounds/`);
    } catch (e) {
        console.log('Could not scan backgrounds folder:', e.message);
        state.availableBackgrounds = [];
    }
    populateBackgroundDropdown();

    // Auto-load last saved project
    try {
        await loadVideoPlan();
        if (state.scenes.length > 0) {
            console.log(`✅ Restored project: ${state.scenes.length} scenes`);
            await jumpToScene(0);
        }
    } catch (e) {
        console.log('No saved project to restore');
    }

    // Initialize WebGL2 Compositor Engine
    initCompositor();

    console.log('🎬 YTA Empire 2 UI Ready');
}

function setupEventListeners() {
    elements.dropZone.addEventListener('click', () => elements.fileInput.click());
    elements.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); elements.dropZone.classList.add('drag-over'); });
    elements.dropZone.addEventListener('dragleave', () => elements.dropZone.classList.remove('drag-over'));
    elements.dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        elements.dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length > 0) handleFileSelect(e.dataTransfer.files[0]);
    });
    elements.fileInput.addEventListener('change', (e) => { if (e.target.files.length > 0) handleFileSelect(e.target.files[0]); });
    elements.btnRemoveAudio.addEventListener('click', removeAudio);
    elements.btnGenerate.addEventListener('click', generateVideo);
    elements.btnRender.addEventListener('click', renderVideo);
    elements.btnCancel.addEventListener('click', cancelProcess);
    elements.btnNew.addEventListener('click', newProject);
    if (elements.btnOpenProject) {
        elements.btnOpenProject.addEventListener('click', openExistingProject);
    }
    elements.btnRefresh.addEventListener('click', refreshApp);
    elements.aiProvider.addEventListener('change', () => {
        // Show/hide Ollama model selection
        if (elements.ollamaModelRow) {
            elements.ollamaModelRow.style.display = elements.aiProvider.value === 'ollama' ? 'block' : 'none';
        }
        saveSettings();
    });
    // Ollama model changes
    if (elements.ollamaModel) elements.ollamaModel.addEventListener('change', saveSettings);
    if (elements.ollamaVisionModel) elements.ollamaVisionModel.addEventListener('change', saveSettings);
    if (elements.aiInstructions) {
        elements.aiInstructions.addEventListener('input', () => {
            state.aiInstructions = elements.aiInstructions.value;
        });
        elements.aiInstructions.addEventListener('change', saveSettings);
    }
    // Global MG animation speed slider
    const globalAnimSpeedEl = document.getElementById('mg-global-anim-speed');
    if (globalAnimSpeedEl) {
        globalAnimSpeedEl.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            document.getElementById('mg-global-anim-speed-val').textContent = `${val.toFixed(1)}x`;
        });
    }
    // Footage source toggle listeners
    ['srcPexels', 'srcPixabay', 'srcYouTube', 'srcNewsVideo', 'srcUnsplash', 'srcGoogleCSE', 'srcBing', 'srcDuckDuckGo', 'srcGoogleScrape'].forEach(key => {
        if (elements[key]) elements[key].addEventListener('change', saveSettings);
    });
    // Transition style listener (disabled - hard cut only)
    // elements.transitionStyle is hidden, always 'cut'
    // SFX controls
    if (elements.sfxEnabled) {
        elements.sfxEnabled.addEventListener('change', () => {
            state.sfxEnabled = elements.sfxEnabled.checked;
            generateSfxClips();
            renderTimeline();
            saveSettings();
        });
    }
    if (elements.sfxVolume) {
        elements.sfxVolume.addEventListener('input', () => {
            state.sfxVolume = parseFloat(elements.sfxVolume.value);
            if (elements.sfxVolumeLabel) elements.sfxVolumeLabel.textContent = `${Math.round(state.sfxVolume * 100)}%`;
            state.sfxClips.forEach(sfx => { sfx.volume = state.sfxVolume; });
            saveSettings();
        });
    }
    // Motion Graphics controls
    if (elements.mgEnabled) {
        elements.mgEnabled.addEventListener('change', () => {
            state.mgEnabled = elements.mgEnabled.checked;
            state.mutedTracks['mg-track'] = !state.mgEnabled;
            renderTimeline();
            saveSettings();
        });
    }
    // Subtitles toggle
    if (elements.subtitlesEnabled) {
        elements.subtitlesEnabled.addEventListener('change', () => {
            state.subtitlesEnabled = elements.subtitlesEnabled.checked;
            saveSettings();
        });
    }
    // Theme dropdown — refresh MG preview when theme changes
    if (elements.buildTheme) {
        elements.buildTheme.addEventListener('change', () => {
            updateMGOverlay();
            saveSettings();
        });
    }
}

function setupVideoControls() {
    // Create SFX audio pool (2 elements for overlapping transitions)
    for (let i = 0; i < 2; i++) {
        const audio = document.createElement('audio');
        audio.preload = 'auto';
        audio.className = 'hidden';
        document.body.appendChild(audio);
        state._sfxAudioPool.push({ element: audio, playing: false });
    }

    // Play button
    if (elements.btnPlay) {
        elements.btnPlay.addEventListener('click', togglePlayback);
    }

    // Mute button
    if (elements.btnMute) {
        elements.btnMute.addEventListener('click', () => {
            state.isMuted = !state.isMuted;
            elements.btnMute.textContent = state.isMuted ? '🔇' : '🔊';
            applyTrackVolumes();
        });
    }

    // Volume slider
    if (elements.volumeSlider) {
        elements.volumeSlider.addEventListener('input', (e) => {
            state.volume = parseFloat(e.target.value);
            applyTrackVolumes();
        });
    }

    // Fullscreen button
    if (elements.btnFullscreen) {
        elements.btnFullscreen.addEventListener('click', () => {
            if (elements.videoContainer) {
                if (document.fullscreenElement) {
                    document.exitFullscreen();
                } else {
                    elements.videoContainer.requestFullscreen();
                }
            }
        });
    }
}

function setupElectronListeners() {
    if (window.electronAPI) {
        window.electronAPI.onBuildProgress((data) => updateProgress(data.percent, data.message));
        window.electronAPI.onRenderProgress((data) => updateProgress(data.percent, data.message));

        // Menu commands (Ctrl+Z/C/V/S routed through Electron menu)
        window.electronAPI.onMenuUndo?.(() => undo());
        window.electronAPI.onMenuCopy?.(() => copySelectedClip());
        window.electronAPI.onMenuPaste?.(() => pasteClip());
        window.electronAPI.onMenuSave?.(() => saveProject());
        window.electronAPI.onMenuDelete?.(() => deleteSelectedClips());
        window.electronAPI.onMenuSelectAll?.(() => selectAllClips());
        window.electronAPI.onMenuNew?.(() => newProject());
    }
}

// ========================================
// Test: Inject all 6 new MG types (Ctrl+Shift+M)
// ========================================
function injectTestMotionGraphics() {
    try {
        if (!state.scenes || state.scenes.length === 0) {
            showNotification('Test MG', 'No scenes loaded — build or load a video first', 'error');
            return;
        }

        const totalDur = state.totalDuration || 60;
        const spacing = Math.max(8, totalDur / 7);
        const style = state.mgStyle || 'clean';

        const testMGs = [
            {
                id: 'test-barchart', type: 'barChart',
                text: 'Market Share 2025',
                subtext: 'Apple:85,Samsung:72,Google:58,Huawei:41,Sony:28',
                duration: 6.0, position: 'center',
            },
            {
                id: 'test-donutchart', type: 'donutChart',
                text: 'Survey Results',
                subtext: 'Agree:45,Disagree:30,Unsure:25',
                duration: 6.0, position: 'center',
            },
            {
                id: 'test-comparison', type: 'comparisonCard',
                text: 'iPhone vs Android',
                subtext: 'Which is better?',
                duration: 5.0, position: 'center',
            },
            {
                id: 'test-timeline', type: 'timeline',
                text: 'Company History',
                subtext: '2018:Founded,2020:Series A,2022:IPO,2024:Global',
                duration: 6.5, position: 'center',
            },
            {
                id: 'test-ranking', type: 'rankingList',
                text: 'Top Languages 2025',
                subtext: 'Python:95,JavaScript:88,TypeScript:76,Rust:62,Go:55',
                duration: 6.0, position: 'center-left',
            },
            {
                id: 'test-kinetic', type: 'kineticText',
                text: 'The Future Is Now',
                subtext: 'Steve Jobs',
                duration: 5.0, position: 'center',
            },
        ];

        // Remove any previously injected test MGs
        state.motionGraphics = (state.motionGraphics || []).filter(mg => !mg.id?.startsWith('test-'));

        // Inject evenly spaced across the video
        testMGs.forEach((mg, i) => {
            const startTime = Math.min(spacing * (i + 0.5), totalDur - mg.duration - 0.5);
            state.motionGraphics.push({
                ...mg,
                startTime: Math.max(0, startTime),
                sceneIndex: 0,
                style,
            });
        });

        renderTracks();
        showNotification('Test MG', 'Injected 6 test motion graphics — seek to each to preview', 'success');
        console.log('[Test MG] Injected 6 test MGs. Timestamps:', state.motionGraphics.filter(m => m.id?.startsWith('test-')).map(m => `${m.type} @ ${m.startTime.toFixed(1)}s`));
    } catch (err) {
        console.error('[Test MG] Error:', err);
        showNotification('Test MG', `Error: ${err.message}`, 'error');
    }
}
// Expose for DevTools console access
window.injectTestMotionGraphics = injectTestMotionGraphics;

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

        // Ctrl shortcuts
        if (e.ctrlKey || e.metaKey) {
            if (e.shiftKey && e.code === 'KeyZ') { e.preventDefault(); redo(); return; }
            if (e.code === 'KeyZ') { e.preventDefault(); undo(); return; }
            if (e.code === 'KeyY') { e.preventDefault(); redo(); return; }
            if (e.code === 'KeyC') { e.preventDefault(); copySelectedClip(); return; }
            if (e.code === 'KeyV') { e.preventDefault(); pasteClip(); return; }
            if (e.code === 'KeyS') { e.preventDefault(); saveProject(); return; }
            if (e.code === 'KeyA') { e.preventDefault(); selectAllClips(); return; }
            if (e.code === 'KeyR') { e.preventDefault(); refreshApp(); return; }
        }

        // F5 to refresh app
        if (e.code === 'F5') { e.preventDefault(); refreshApp(); return; }

        // Delete selected clips (single or multi)
        if ((e.code === 'Delete' || e.code === 'Backspace') && (state.selectedClipIndices.length > 0 || state.selectedClipIndex >= 0)) {
            e.preventDefault(); deleteSelectedClips(); return;
        }

        // Ctrl+Shift+M: Inject test motion graphics (all 6 new types)
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyM') {
            e.preventDefault(); injectTestMotionGraphics(); return;
        }

        if (e.code === 'Space') { e.preventDefault(); togglePlayback(); }
        else if (e.shiftKey && e.code === 'KeyF') { e.preventDefault(); zoomToFit(); }
        else if (e.code === 'KeyF') { e.preventDefault(); cutClipAtPlayhead(); }
        else if (e.code === 'ArrowLeft') { e.preventDefault(); seekToTime(state.currentTime - 1); }
        else if (e.code === 'ArrowRight') { e.preventDefault(); seekToTime(state.currentTime + 1); }
        else if (e.code === 'Home') { e.preventDefault(); seekToTime(0); }
        else if (e.code === 'End') { e.preventDefault(); seekToTime(state.totalDuration); }
        else if (e.code === 'Escape') { deselectClip(); }
    });
}

// ========================================
// Undo System
// ========================================
function pushUndoState() {
    state.undoStack.push(JSON.parse(JSON.stringify(state.scenes)));
    if (state.undoStack.length > state.maxUndoLevels) {
        state.undoStack.shift();
    }
    // Any new action invalidates the redo stack
    state.redoStack = [];
    // Trigger auto-save to .fvp file (debounced)
    triggerAutoSave();
}

function undo() {
    if (state.undoStack.length === 0) {
        showToast('Nothing to undo', 'info');
        return;
    }
    // Save current state to redo stack before restoring
    state.redoStack.push(JSON.parse(JSON.stringify(state.scenes)));
    state.scenes = state.undoStack.pop();
    state.selectedClipIndex = -1;
    state.selectedClipIndices = [];
    recalcTotalDuration();
    renderTimeline();
    updateClipProperties();
    // Reload preview to match restored scene state
    loadActiveScenes();
    showToast('Undo', 'info');
}

function redo() {
    if (state.redoStack.length === 0) {
        showToast('Nothing to redo', 'info');
        return;
    }
    // Save current state to undo stack before redoing
    state.undoStack.push(JSON.parse(JSON.stringify(state.scenes)));
    state.scenes = state.redoStack.pop();
    state.selectedClipIndex = -1;
    state.selectedClipIndices = [];
    recalcTotalDuration();
    renderTimeline();
    updateClipProperties();
    // Reload preview to match restored scene state
    loadActiveScenes();
    showToast('Redo', 'info');
}

// ========================================
// Clipboard (Copy / Paste / Delete)
// ========================================
function selectClip(index, ctrlKey = false) {
    if (ctrlKey) {
        // Multi-select: toggle this clip in the selection
        const pos = state.selectedClipIndices.indexOf(index);
        if (pos >= 0) {
            state.selectedClipIndices.splice(pos, 1);
        } else {
            state.selectedClipIndices.push(index);
        }
        // Primary selection = last added (for properties panel)
        state.selectedClipIndex = state.selectedClipIndices.length > 0
            ? state.selectedClipIndices[state.selectedClipIndices.length - 1]
            : -1;
    } else {
        // Single select: clear others
        state.selectedClipIndices = [index];
        state.selectedClipIndex = index;
    }
    // Deselect any MG selection
    state.selectedMgIndex = -1;
    document.querySelectorAll('.mg-clip').forEach(c => c.classList.remove('selected'));
    // Update visual selection
    document.querySelectorAll('.timeline-clip').forEach(c => c.classList.remove('selected'));
    state.selectedClipIndices.forEach(idx => {
        const clip = document.querySelector(`.timeline-clip[data-index="${idx}"]`);
        if (clip) clip.classList.add('selected');
    });
    updateClipProperties();
    applySceneTransform(state.selectedClipIndex);
}

function selectAllClips() {
    if (state.scenes.length === 0) return;
    state.selectedClipIndices = state.scenes.map((_, i) => i);
    state.selectedClipIndex = state.selectedClipIndices[state.selectedClipIndices.length - 1];
    document.querySelectorAll('.timeline-clip[data-index]').forEach(c => c.classList.add('selected'));
    updateClipProperties();
    const count = state.selectedClipIndices.length;
    showToast(`Selected all ${count} clips`, 'info');
}

function deselectClip() {
    state.selectedClipIndex = -1;
    state.selectedClipIndices = [];
    state.selectedMgIndex = -1;
    clearSceneTransform();
    document.querySelectorAll('.timeline-clip').forEach(c => c.classList.remove('selected'));
    document.querySelectorAll('.mg-clip').forEach(c => c.classList.remove('selected'));
    updateClipProperties();
}

function copySelectedClip() {
    if (state.selectedClipIndex < 0 || !state.scenes[state.selectedClipIndex]) {
        showToast('No clip selected to copy', 'info');
        return;
    }
    state.clipboard = JSON.parse(JSON.stringify(state.scenes[state.selectedClipIndex]));
    showToast('Clip copied', 'info');
}

function pasteClip() {
    if (!state.clipboard) {
        showToast('Nothing to paste', 'info');
        return;
    }
    pushUndoState();
    const clip = JSON.parse(JSON.stringify(state.clipboard));
    // Place at current playhead position
    const duration = clip.endTime - clip.startTime;
    clip.startTime = state.currentTime;
    clip.endTime = state.currentTime + duration;
    // Keep the original scene index so the correct video file loads (scene-{index}.mp4)
    // Do NOT overwrite clip.index - it must point to the original scene's video file
    state.scenes.push(clip);
    state.scenes.sort((a, b) => a.startTime - b.startTime);
    recalcTotalDuration();
    renderTimeline();
    showToast('Clip pasted', 'info');
}

function deleteSelectedClip() {
    // Legacy single-clip delete, now delegates to multi
    deleteSelectedClips();
}

function deleteSelectedClips() {
    // Collect indices to delete (multi-select or single)
    let toDelete = [...state.selectedClipIndices];
    if (toDelete.length === 0 && state.selectedClipIndex >= 0) {
        toDelete = [state.selectedClipIndex];
    }
    toDelete = toDelete.filter(i => i >= 0 && i < state.scenes.length);
    if (toDelete.length === 0) return;

    pushUndoState();
    // Sort descending so splicing doesn't shift indices
    toDelete.sort((a, b) => b - a);
    for (const idx of toDelete) {
        state.scenes.splice(idx, 1);
    }
    state.selectedClipIndex = -1;
    state.selectedClipIndices = [];
    recalcTotalDuration();
    renderTimeline();
    showToast(`${toDelete.length} clip${toDelete.length > 1 ? 's' : ''} deleted`, 'info');
}

// ========================================
// Cut Clip at Playhead (F key)
// ========================================
function cutClipAtPlayhead() {
    const idx = getSceneAtTime(state.currentTime);
    if (idx < 0) {
        showToast('No clip at playhead to cut', 'info');
        return;
    }
    const scene = state.scenes[idx];

    // Can't cut MG scenes (no media file to split)
    if (scene.isMGScene) {
        showToast('Cannot cut motion graphic scenes', 'info');
        return;
    }

    const cutTime = state.currentTime;

    // Don't cut if too close to edges (min 0.2s per piece)
    if (cutTime - scene.startTime < 0.2 || scene.endTime - cutTime < 0.2) {
        showToast('Clip too short to cut here', 'info');
        return;
    }

    pushUndoState();

    // Create the second half (right side of cut)
    const rightClip = JSON.parse(JSON.stringify(scene));
    rightClip.startTime = cutTime;
    // mediaOffset tracks how far into the source video this clip starts
    rightClip.mediaOffset = (scene.mediaOffset || 0) + (cutTime - scene.startTime);

    // Trim the original (left side of cut)
    scene.endTime = cutTime;

    // Insert right clip after the original
    state.scenes.splice(idx + 1, 0, rightClip);
    recalcTotalDuration();
    renderTimeline();
    showToast('Clip cut at playhead (F)', 'info');
}

// Recalculate totalDuration from scenes + audio
function recalcTotalDuration() {
    const scenesEnd = state.scenes.length > 0 ? Math.max(...state.scenes.map(s => s.endTime)) : 0;
    const audioDur = (elements.previewAudio && isFinite(elements.previewAudio.duration)) ? elements.previewAudio.duration : 0;
    state.totalDuration = Math.max(scenesEnd, audioDur);
}

// ========================================
// Clip Properties (Scale / Position)
// ========================================
function updateClipProperties() {
    const panel = elements.clipProperties;
    const overlayPanel = document.getElementById('overlay-properties');
    const mgPanel = document.getElementById('mg-properties');
    const emptyState = document.getElementById('properties-empty');
    const titleEl = document.getElementById('properties-title');

    // Hide all panels first
    if (panel) panel.classList.add('hidden');
    if (overlayPanel) overlayPanel.classList.add('hidden');
    if (mgPanel) mgPanel.classList.add('hidden');

    // MG selected?
    if (state.selectedMgIndex >= 0 && state.motionGraphics[state.selectedMgIndex]) {
        if (emptyState) emptyState.classList.add('hidden');
        const mgTypeLabels = { headline: 'Headline', lowerThird: 'Lower Third', statCounter: 'Stat Counter', callout: 'Callout', bulletList: 'Bullet List', focusWord: 'Focus Word', progressBar: 'Progress Bar' };
        const mgType = state.motionGraphics[state.selectedMgIndex].type;
        if (titleEl) titleEl.textContent = mgTypeLabels[mgType] || 'Motion Graphic';
        updateMgProperties();
        expandPropertiesSection();
        return;
    }

    // No scene selected?
    if (state.selectedClipIndex < 0 || !state.scenes[state.selectedClipIndex]) {
        if (emptyState) emptyState.classList.remove('hidden');
        if (titleEl) titleEl.textContent = 'Properties';
        return;
    }

    const scene = state.scenes[state.selectedClipIndex];

    // Full-screen MG scene on V3 — show MG properties panel
    if (scene.isMGScene) {
        if (emptyState) emptyState.classList.add('hidden');
        const mgTypeLabels = { barChart: 'Bar Chart', donutChart: 'Donut Chart', rankingList: 'Ranking List', timeline: 'Timeline', comparisonCard: 'Comparison', bulletList: 'Bullet List', mapChart: 'Map', articleHighlight: 'Article' };
        if (titleEl) titleEl.textContent = mgTypeLabels[scene.type] || 'Motion Graphic';
        // Use MG properties panel with the scene's mgData
        const mgData = scene.mgData || scene;
        state.selectedMgIndex = -1; // Not from MG track
        state._selectedMgScene = scene; // Temp reference for MG panel
        updateMgPropertiesForScene(scene);
        expandPropertiesSection();
        return;
    }

    // Regular video/image clip
    if (!panel) return;
    if (emptyState) emptyState.classList.add('hidden');
    if (titleEl) titleEl.textContent = 'Clip Properties';
    panel.classList.remove('hidden');
    expandPropertiesSection();

    const scale = scene.scale !== undefined ? scene.scale : 1;
    const posX = scene.posX || 0;
    const posY = scene.posY || 0;

    if (elements.propScale) { elements.propScale.value = scale; }
    if (elements.propPosX) { elements.propPosX.value = posX; }
    if (elements.propPosY) { elements.propPosY.value = posY; }
    if (elements.propScaleVal) { elements.propScaleVal.value = scale.toFixed(2); }
    if (elements.propPosXVal) { elements.propPosXVal.value = `${posX}%`; }
    if (elements.propPosYVal) { elements.propPosYVal.value = `${posY}%`; }

    const volume = scene.volume !== undefined ? scene.volume : 1;
    if (elements.propVolume) { elements.propVolume.value = volume; }
    if (elements.propVolumeVal) { elements.propVolumeVal.value = `${Math.round(volume * 100)}%`; }

    // Background dropdown
    if (elements.propBackground) {
        elements.propBackground.value = scene.background || 'none';
    }
    // Fit mode dropdown
    if (elements.propFitMode) {
        elements.propFitMode.value = scene.fitMode || 'cover';
    }
    // Crop sliders
    const cropTop = scene.cropTop || 0;
    const cropBottom = scene.cropBottom || 0;
    const cropLeft = scene.cropLeft || 0;
    const cropRight = scene.cropRight || 0;
    if (elements.propCropTop) { elements.propCropTop.value = cropTop; }
    if (elements.propCropBottom) { elements.propCropBottom.value = cropBottom; }
    if (elements.propCropLeft) { elements.propCropLeft.value = cropLeft; }
    if (elements.propCropRight) { elements.propCropRight.value = cropRight; }
    if (elements.propCropTopVal) { elements.propCropTopVal.value = `${cropTop}%`; }
    if (elements.propCropBottomVal) { elements.propCropBottomVal.value = `${cropBottom}%`; }
    if (elements.propCropLeftVal) { elements.propCropLeftVal.value = `${cropLeft}%`; }
    if (elements.propCropRightVal) { elements.propCropRightVal.value = `${cropRight}%`; }

    // Border radius slider
    const borderRadius = scene.borderRadius || 0;
    if (elements.propBorderRadius) { elements.propBorderRadius.value = borderRadius; }
    if (elements.propBorderRadiusVal) { elements.propBorderRadiusVal.value = `${borderRadius}%`; }

    // Animate checkbox (only for images)
    if (elements.propAnimateRow) {
        const isImage = scene.mediaType === 'image';
        elements.propAnimateRow.style.display = isImage ? '' : 'none';
        if (isImage && elements.propAnimate) {
            elements.propAnimate.checked = scene.kenBurnsEnabled !== false; // default true
        }
    }
}

function expandPropertiesSection() {
    const section = document.getElementById('properties-section');
    if (section) section.classList.remove('collapsed');
}

function updateOverlayProperties(scene) {
    const panel = document.getElementById('overlay-properties');
    if (!panel) return;
    panel.classList.remove('hidden');

    const intensity = scene.overlayIntensity !== undefined ? scene.overlayIntensity : 0.5;
    const blend = scene.blendMode || 'screen';
    const scale = scene.scale !== undefined ? scene.scale : 1;

    const intensityEl = document.getElementById('overlay-intensity');
    const intensityVal = document.getElementById('overlay-intensity-val');
    const blendEl = document.getElementById('overlay-blend');
    const scaleEl = document.getElementById('overlay-scale');
    const scaleVal = document.getElementById('overlay-scale-val');

    if (intensityEl) intensityEl.value = intensity;
    if (intensityVal) intensityVal.textContent = `${Math.round(intensity * 100)}%`;
    if (blendEl) blendEl.value = blend;
    if (scaleEl) scaleEl.value = scale;
    if (scaleVal) scaleVal.textContent = scale.toFixed(2);
}

function updateMgProperties() {
    const panel = document.getElementById('mg-properties');
    if (!panel) return;
    panel.classList.remove('hidden');

    const mg = state.motionGraphics[state.selectedMgIndex];
    if (!mg) return;

    const textEl = document.getElementById('mg-text');
    const subtextEl = document.getElementById('mg-subtext');
    const posEl = document.getElementById('mg-position');
    const durEl = document.getElementById('mg-duration');
    const durVal = document.getElementById('mg-duration-val');
    const typeEl = document.getElementById('mg-type');
    const styleEl = document.getElementById('mg-style');

    if (textEl) textEl.value = mg.text || '';
    if (subtextEl) subtextEl.value = mg.subtext || '';
    if (posEl) posEl.value = mg.position || 'center';
    if (durEl) durEl.value = mg.duration || 3;
    if (durVal) durVal.textContent = `${(mg.duration || 3).toFixed(1)}s`;
    if (typeEl) typeEl.value = mg.type || 'headline';
    if (styleEl) styleEl.value = mg.style || state.mgStyle || 'clean';

    // Animation speed slider
    const animSpeedEl = document.getElementById('mg-anim-speed');
    const animSpeedVal = document.getElementById('mg-anim-speed-val');
    if (animSpeedEl) animSpeedEl.value = mg.animationSpeed || 1;
    if (animSpeedVal) animSpeedVal.textContent = `${(mg.animationSpeed || 1).toFixed(1)}x`;

    // Show map style row only for mapChart
    const mapStyleRow = document.getElementById('mg-map-style-row');
    const mapStyleEl = document.getElementById('mg-map-style');
    if (mapStyleRow) mapStyleRow.style.display = mg.type === 'mapChart' ? '' : 'none';
    if (mapStyleEl && mg.type === 'mapChart') mapStyleEl.value = mg.mapStyle || 'dark';
}

// Show MG properties panel for a V3 full-screen MG scene
function updateMgPropertiesForScene(scene) {
    const panel = document.getElementById('mg-properties');
    if (!panel) return;
    panel.classList.remove('hidden');

    const mg = scene.mgData || scene;
    const textEl = document.getElementById('mg-text');
    const subtextEl = document.getElementById('mg-subtext');
    const posEl = document.getElementById('mg-position');
    const durEl = document.getElementById('mg-duration');
    const durVal = document.getElementById('mg-duration-val');
    const typeEl = document.getElementById('mg-type');
    const styleEl = document.getElementById('mg-style');

    if (textEl) textEl.value = mg.text || scene.text || '';
    if (subtextEl) subtextEl.value = mg.subtext || scene.subtext || '';
    if (posEl) posEl.value = mg.position || scene.position || 'center';
    const dur = scene.endTime - scene.startTime;
    if (durEl) durEl.value = dur || 5;
    if (durVal) durVal.textContent = `${(dur || 5).toFixed(1)}s`;
    if (typeEl) typeEl.value = mg.type || scene.type || 'barChart';
    if (styleEl) styleEl.value = mg.style || scene.style || state.mgStyle || 'clean';

    // Animation speed slider
    const animSpeedEl = document.getElementById('mg-anim-speed');
    const animSpeedVal = document.getElementById('mg-anim-speed-val');
    const animSpeed = mg.animationSpeed || scene.animationSpeed || 1;
    if (animSpeedEl) animSpeedEl.value = animSpeed;
    if (animSpeedVal) animSpeedVal.textContent = `${animSpeed.toFixed(1)}x`;

    // Show map style row only for mapChart
    const sceneType = mg.type || scene.type;
    const mapStyleRow = document.getElementById('mg-map-style-row');
    const mapStyleEl = document.getElementById('mg-map-style');
    if (mapStyleRow) mapStyleRow.style.display = sceneType === 'mapChart' ? '' : 'none';
    if (mapStyleEl && sceneType === 'mapChart') mapStyleEl.value = mg.mapStyle || scene.mapStyle || 'dark';
}

function setupClipPropertyListeners() {
    // Capture undo state once when user starts dragging any property slider
    const propSliders = [elements.propScale, elements.propPosX, elements.propPosY, elements.propVolume,
        elements.propCropTop, elements.propCropBottom, elements.propCropLeft, elements.propCropRight, elements.propBorderRadius];
    propSliders.forEach(slider => {
        if (slider) {
            slider.addEventListener('pointerdown', () => {
                if (state.selectedClipIndex >= 0) pushUndoState();
            });
        }
    });

    if (elements.propScale) {
        elements.propScale.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const val = parseFloat(e.target.value);
            state.scenes[state.selectedClipIndex].scale = val;
            if (elements.propScaleVal) elements.propScaleVal.value = val.toFixed(2);
            applySceneTransform(state.selectedClipIndex);
        });
    }
    if (elements.propPosX) {
        elements.propPosX.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const val = parseInt(e.target.value);
            state.scenes[state.selectedClipIndex].posX = val;
            if (elements.propPosXVal) elements.propPosXVal.value = `${val}%`;
            applySceneTransform(state.selectedClipIndex);
        });
    }
    if (elements.propPosY) {
        elements.propPosY.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const val = parseInt(e.target.value);
            state.scenes[state.selectedClipIndex].posY = val;
            if (elements.propPosYVal) elements.propPosYVal.value = `${val}%`;
            applySceneTransform(state.selectedClipIndex);
        });
    }
    if (elements.propVolume) {
        elements.propVolume.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const val = parseFloat(e.target.value);
            state.scenes[state.selectedClipIndex].volume = val;
            if (elements.propVolumeVal) elements.propVolumeVal.value = `${Math.round(val * 100)}%`;
            applyTrackVolumes();
        });
    }
    // Crop sliders
    ['cropTop', 'cropBottom', 'cropLeft', 'cropRight'].forEach(prop => {
        const capProp = prop.charAt(0).toUpperCase() + prop.slice(1);
        const slider = elements[`propCrop${capProp.replace('crop', '').replace('Crop', '')}`] || elements[`prop${capProp}`];
        const valEl = elements[`propCrop${capProp.replace('crop', '').replace('Crop', '')}Val`] || elements[`prop${capProp}Val`];
        // Use direct element references
        const elMap = { cropTop: 'propCropTop', cropBottom: 'propCropBottom', cropLeft: 'propCropLeft', cropRight: 'propCropRight' };
        const valMap = { cropTop: 'propCropTopVal', cropBottom: 'propCropBottomVal', cropLeft: 'propCropLeftVal', cropRight: 'propCropRightVal' };
        const sl = elements[elMap[prop]];
        const vl = elements[valMap[prop]];
        if (sl) {
            sl.addEventListener('input', (e) => {
                if (state.selectedClipIndex < 0) return;
                const val = parseInt(e.target.value);
                state.scenes[state.selectedClipIndex][prop] = val;
                if (vl) vl.value = `${val}%`;
                applySceneTransform(state.selectedClipIndex);
            });
        }
    });
    // Border radius slider
    if (elements.propBorderRadius) {
        elements.propBorderRadius.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const val = parseInt(e.target.value);
            state.scenes[state.selectedClipIndex].borderRadius = val;
            if (elements.propBorderRadiusVal) elements.propBorderRadiusVal.value = `${val}%`;
            applySceneTransform(state.selectedClipIndex);
        });
    }

    // Editable value inputs — commit on Enter or blur
    function setupValueInput(inputEl, sliderEl, { parse, format, apply }) {
        if (!inputEl) return;
        const commit = () => {
            if (state.selectedClipIndex < 0) return;
            const raw = inputEl.value.replace(/%/g, '').trim();
            let val = parse(raw);
            if (isNaN(val)) return;
            // Clamp to slider range
            const min = parseFloat(sliderEl?.min ?? -Infinity);
            const max = parseFloat(sliderEl?.max ?? Infinity);
            val = Math.min(max, Math.max(min, val));
            pushUndoState();
            if (sliderEl) sliderEl.value = val;
            inputEl.value = format(val);
            apply(val);
        };
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); inputEl.blur(); }
            if (e.key === 'Escape') { inputEl.blur(); }
        });
        inputEl.addEventListener('blur', commit);
        // Select all on focus for easy overwrite
        inputEl.addEventListener('focus', () => inputEl.select());
    }

    setupValueInput(elements.propScaleVal, elements.propScale, {
        parse: parseFloat,
        format: v => v.toFixed(2),
        apply: v => { state.scenes[state.selectedClipIndex].scale = v; applySceneTransform(state.selectedClipIndex); }
    });
    setupValueInput(elements.propPosXVal, elements.propPosX, {
        parse: parseInt,
        format: v => `${v}%`,
        apply: v => { state.scenes[state.selectedClipIndex].posX = v; applySceneTransform(state.selectedClipIndex); }
    });
    setupValueInput(elements.propPosYVal, elements.propPosY, {
        parse: parseInt,
        format: v => `${v}%`,
        apply: v => { state.scenes[state.selectedClipIndex].posY = v; applySceneTransform(state.selectedClipIndex); }
    });
    setupValueInput(elements.propVolumeVal, elements.propVolume, {
        parse: v => parseFloat(v) / 100,
        format: v => `${Math.round(v * 100)}%`,
        apply: v => { state.scenes[state.selectedClipIndex].volume = v; applyTrackVolumes(); }
    });
    ['cropTop', 'cropBottom', 'cropLeft', 'cropRight'].forEach(prop => {
        const elMap = { cropTop: 'propCropTop', cropBottom: 'propCropBottom', cropLeft: 'propCropLeft', cropRight: 'propCropRight' };
        const valMap = { cropTop: 'propCropTopVal', cropBottom: 'propCropBottomVal', cropLeft: 'propCropLeftVal', cropRight: 'propCropRightVal' };
        setupValueInput(elements[valMap[prop]], elements[elMap[prop]], {
            parse: parseInt,
            format: v => `${v}%`,
            apply: v => { state.scenes[state.selectedClipIndex][prop] = v; applySceneTransform(state.selectedClipIndex); }
        });
    });
    setupValueInput(elements.propBorderRadiusVal, elements.propBorderRadius, {
        parse: parseInt,
        format: v => `${v}%`,
        apply: v => { state.scenes[state.selectedClipIndex].borderRadius = v; applySceneTransform(state.selectedClipIndex); }
    });

    if (elements.propReset) {
        elements.propReset.addEventListener('click', () => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            const scene = state.scenes[state.selectedClipIndex];
            scene.scale = 1;
            scene.posX = 0;
            scene.posY = 0;
            scene.volume = 1;
            scene.background = 'none';
            scene.fitMode = 'cover';
            scene.cropTop = 0;
            scene.cropBottom = 0;
            scene.cropLeft = 0;
            scene.cropRight = 0;
            scene.borderRadius = 0;
            updateClipProperties();
            applySceneTransform(state.selectedClipIndex);
            applyTrackVolumes();
            loadActiveScenes();
        });
    }
    // Background dropdown
    if (elements.propBackground) {
        elements.propBackground.addEventListener('change', (e) => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            state.scenes[state.selectedClipIndex].background = e.target.value;
            loadActiveScenes();
        });
    }
    // Fit mode dropdown
    if (elements.propFitMode) {
        elements.propFitMode.addEventListener('change', (e) => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            const scene = state.scenes[state.selectedClipIndex];
            scene.fitMode = e.target.value;
            // If switching to contain without a background, auto-set blur
            if (e.target.value === 'contain' && (!scene.background || scene.background === 'none')) {
                scene.background = 'blur';
                if (elements.propBackground) elements.propBackground.value = 'blur';
            }
            loadActiveScenes();
        });
    }
    // Animate checkbox
    if (elements.propAnimate) {
        elements.propAnimate.addEventListener('change', (e) => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            state.scenes[state.selectedClipIndex].kenBurnsEnabled = e.target.checked;
            loadActiveScenes();
        });
    }
}

/**
 * Populate the Background dropdown with available pattern files from assets/backgrounds/
 */
function populateBackgroundDropdown() {
    const sel = elements.propBackground;
    if (!sel) return;
    // Keep the first two built-in options (None, Blur)
    while (sel.options.length > 2) sel.remove(2);
    // Add built-in gradient backgrounds
    if (Object.keys(GRADIENT_BACKGROUNDS).length > 0) {
        const grp = document.createElement('optgroup');
        grp.label = 'Gradients';
        for (const [id, css] of Object.entries(GRADIENT_BACKGROUNDS)) {
            const opt = document.createElement('option');
            opt.value = `gradient:${id}`;
            opt.textContent = GRADIENT_BACKGROUND_NAMES[id] || id;
            grp.appendChild(opt);
        }
        sel.appendChild(grp);
    }
    // Add pattern files from assets/backgrounds/
    if (state.availableBackgrounds.length > 0) {
        const grp = document.createElement('optgroup');
        grp.label = 'Custom Files';
        for (const bg of state.availableBackgrounds) {
            const opt = document.createElement('option');
            opt.value = `pattern:${bg.filename}`;
            const icon = bg.mediaType === 'video' ? '🎬' : '🖼️';
            opt.textContent = `${icon} ${bg.name}`;
            grp.appendChild(opt);
        }
        sel.appendChild(grp);
    }
}

function setupMgPropertyListeners() {
    const textEl = document.getElementById('mg-text');
    const subtextEl = document.getElementById('mg-subtext');
    const posEl = document.getElementById('mg-position');
    const durEl = document.getElementById('mg-duration');
    const typeEl = document.getElementById('mg-type');
    const styleEl = document.getElementById('mg-style');

    // Helper: get the MG object being edited (overlay MG or V3 fullscreen MG scene)
    function getActiveMG() {
        if (state.selectedMgIndex >= 0 && state.motionGraphics[state.selectedMgIndex]) {
            return { mg: state.motionGraphics[state.selectedMgIndex], isScene: false };
        }
        if (state._selectedMgScene) {
            return { mg: state._selectedMgScene, isScene: true };
        }
        return null;
    }

    if (textEl) {
        textEl.addEventListener('input', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.text = e.target.value;
            if (active.mg.mgData) active.mg.mgData.text = e.target.value;
            renderTracks();
        });
    }
    if (subtextEl) {
        subtextEl.addEventListener('input', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.subtext = e.target.value;
            if (active.mg.mgData) active.mg.mgData.subtext = e.target.value;
        });
    }
    if (posEl) {
        posEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.position = e.target.value;
            if (active.mg.mgData) active.mg.mgData.position = e.target.value;
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
        });
    }
    if (durEl) {
        durEl.addEventListener('input', (e) => {
            const active = getActiveMG();
            if (!active) return;
            const val = parseFloat(e.target.value);
            active.mg.duration = val;
            if (active.mg.mgData) active.mg.mgData.duration = val;
            if (active.isScene) {
                active.mg.endTime = active.mg.startTime + val;
            }
            document.getElementById('mg-duration-val').textContent = `${val.toFixed(1)}s`;
            renderTracks();
        });
    }
    if (typeEl) {
        typeEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.type = e.target.value;
            if (active.mg.mgData) active.mg.mgData.type = e.target.value;
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
            renderTracks();
        });
    }
    if (styleEl) {
        styleEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.style = e.target.value;
            if (active.mg.mgData) active.mg.mgData.style = e.target.value;
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
        });
    }

    // Map style dropdown (only for mapChart type)
    const mapStyleEl = document.getElementById('mg-map-style');
    if (mapStyleEl) {
        mapStyleEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.mapStyle = e.target.value;
            if (active.mg.mgData) active.mg.mgData.mapStyle = e.target.value;
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
        });
    }

    // Show/hide map style row when type changes
    if (typeEl) {
        typeEl.addEventListener('change', () => {
            const mapStyleRow = document.getElementById('mg-map-style-row');
            if (mapStyleRow) mapStyleRow.style.display = typeEl.value === 'mapChart' ? '' : 'none';
        });
    }

    // Animation speed slider
    const animSpeedEl = document.getElementById('mg-anim-speed');
    if (animSpeedEl) {
        animSpeedEl.addEventListener('input', (e) => {
            const active = getActiveMG();
            if (!active) return;
            const val = parseFloat(e.target.value);
            active.mg.animationSpeed = val;
            if (active.mg.mgData) active.mg.mgData.animationSpeed = val;
            document.getElementById('mg-anim-speed-val').textContent = `${val.toFixed(1)}x`;
        });
    }
}

/**
 * Compute effective volume for a scene (clip volume * master volume * track mute)
 */
function getSceneVolume(scene) {
    if (state.isMuted) return 0;
    const trackId = scene.trackId || 'video-track-1';
    if (state.mutedTracks[trackId]) return 0;
    const clipVol = scene.volume !== undefined ? scene.volume : 1;
    return clipVol * state.volume;
}

/**
 * Apply volume to all active video elements and audio based on clip volume + track mute
 */
function applyTrackVolumes() {
    // Video tracks
    if (state.activeSceneIndices) {
        state.activeSceneIndices.forEach(idx => {
            const scene = state.scenes[idx];
            if (!scene) return;
            const trackNum = (scene.trackId || 'video-track-1').match(/(\d)/)?.[1] || '1';
            const video = getActiveTrackVideo(trackNum);
            if (video) {
                video.volume = getSceneVolume(scene);
                video.muted = false; // Let volume control handle it
            }
        });
    }

    // Voice track
    if (elements.previewAudio) {
        const voiceMuted = state.mutedTracks['audio-track'] || false;
        elements.previewAudio.volume = (state.isMuted || voiceMuted) ? 0 : state.volume;
    }
}

/**
 * Apply scale/position transform to a specific video element
 * @param {HTMLVideoElement} videoElement - The video element to transform
 * @param {Object} scene - The scene with scale/position properties
 */
function applySceneTransformToVideo(videoElement, scene) {
    if (!videoElement || !scene) return;

    const scale = scene.scale !== undefined ? scene.scale : 1;
    const posX = scene.posX || 0;
    const posY = scene.posY || 0;

    // Apply transform - translate first then scale
    videoElement.style.transform = `translate(${posX}%, ${posY}%) scale(${scale})`;
    videoElement.style.transformOrigin = 'center center';
    // Fit mode: contain shows full media (vertical/square), cover fills frame (16:9)
    videoElement.style.objectFit = scene.fitMode || 'cover';

    // Crop on the media element (so scaling can push crop edges out of view)
    applyCrop(videoElement, scene);
    videoElement.style.borderRadius = '';

    // Border-radius on the track wrapper (clean rounded corners)
    const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
    const wrapper = elements[`trackWrapper${trackNum}`];
    if (wrapper) {
        applyRadius(wrapper, scene);
        wrapper.style.clipPath = ''; // Ensure no leftover clip-path on wrapper
    }
}

/**
 * Apply transform to a scene by index (finds the scene's track video)
 */
function applySceneTransform(sceneIndex) {
    if (sceneIndex < 0 || !state.scenes[sceneIndex]) return;

    const scene = state.scenes[sceneIndex];
    const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
    const isImage = scene.mediaType === 'image';

    if (isImage) {
        // For images, update via Ken Burns (which combines scene transform + KB animation)
        const img = elements[`imgTrack${trackNum}`];
        if (img) updateKenBurnsTransform(img, scene);
    } else {
        const video = getActiveTrackVideo(trackNum);
        if (video) applySceneTransformToVideo(video, scene);
    }
}

function clearSceneTransform() {
    // Clear transform and crop from all track video/img elements (both A and B buffers)
    [elements.videoTrack1, elements.videoTrack2, elements.videoTrack3,
     elements.videoTrack1B, elements.videoTrack2B, elements.videoTrack3B].forEach(video => {
        if (video) {
            video.style.transform = '';
            video.style.transformOrigin = '';
            video.style.objectFit = '';
            video.style.clipPath = '';
        }
    });
    [elements.imgTrack1, elements.imgTrack2, elements.imgTrack3].forEach(img => {
        if (img) {
            img.style.clipPath = '';
        }
    });
    // Clear radius from track wrappers
    [elements.trackWrapper1, elements.trackWrapper2, elements.trackWrapper3].forEach(wrapper => {
        if (wrapper) {
            wrapper.style.clipPath = '';
            wrapper.style.borderRadius = '';
            wrapper.style.overflow = '';
        }
    });
}

// ========================================
// Preview Drag & Scroll (Scale/Position)
// ========================================
function setupPreviewDrag() {
    const videoFrame = elements.videoContainer;
    const previewArea = elements.previewContainer;
    if (!videoFrame || !previewArea) return;

    // Clip position drag (left button on video frame)
    let isDragging = false;
    let startX = 0, startY = 0;
    let startPosX = 0, startPosY = 0;

    videoFrame.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // Only left button
        if (state.selectedClipIndex < 0 || !state.scenes[state.selectedClipIndex]) return;
        if (e.target.closest('.video-controls')) return;

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const scene = state.scenes[state.selectedClipIndex];
        startPosX = scene.posX || 0;
        startPosY = scene.posY || 0;
        videoFrame.style.cursor = 'grabbing';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging || state.selectedClipIndex < 0) return;

        const rect = videoFrame.getBoundingClientRect();
        const deltaX = ((e.clientX - startX) / rect.width) * 100;
        const deltaY = ((e.clientY - startY) / rect.height) * 100;

        const scene = state.scenes[state.selectedClipIndex];
        scene.posX = Math.max(-50, Math.min(50, Math.round(startPosX + deltaX)));
        scene.posY = Math.max(-50, Math.min(50, Math.round(startPosY + deltaY)));

        applySceneTransform(state.selectedClipIndex);
        updateClipProperties();
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            videoFrame.style.cursor = '';
        }
    });

    // ========================================
    // Preview zoom & pan (works from entire preview area)
    // ========================================

    // Scroll wheel: smooth zoom (works anywhere in preview area)
    previewArea.addEventListener('wheel', (e) => {
        e.preventDefault();

        const currentZoom = state.previewZoom === 'fit' ? 100 : state.previewZoom;
        const delta = e.deltaY < 0 ? 5 : -5; // Slower zoom: 5% increments
        let newZoom = currentZoom + delta;

        if (newZoom < 25) newZoom = 'fit';
        else if (newZoom > 200) newZoom = 200;
        else newZoom = Math.round(newZoom / 5) * 5;

        setPreviewZoom(newZoom);
    });

    // Right mouse button: pan when zoomed (works anywhere in preview area)
    let isPanning = false;
    let panStartX = 0;
    let panStartY = 0;
    let panScrollLeft = 0;
    let panScrollTop = 0;

    previewArea.addEventListener('mousedown', (e) => {
        if (e.button === 2 && state.previewZoom !== 'fit') { // Right button
            e.preventDefault();
            isPanning = true;
            panStartX = e.clientX;
            panStartY = e.clientY;
            panScrollLeft = previewArea.scrollLeft;
            panScrollTop = previewArea.scrollTop;
            previewArea.style.cursor = 'grabbing';
        }
    });

    previewArea.addEventListener('mousemove', (e) => {
        if (isPanning) {
            e.preventDefault();
            const dx = e.clientX - panStartX;
            const dy = e.clientY - panStartY;
            previewArea.scrollLeft = panScrollLeft - dx;
            previewArea.scrollTop = panScrollTop - dy;
        }
    });

    previewArea.addEventListener('mouseup', (e) => {
        if (e.button === 2 && isPanning) {
            isPanning = false;
            previewArea.style.cursor = '';
        }
    });

    previewArea.addEventListener('mouseleave', () => {
        if (isPanning) {
            isPanning = false;
            previewArea.style.cursor = '';
        }
    });

    // Prevent default context menu on right click when zoomed
    previewArea.addEventListener('contextmenu', (e) => {
        if (state.previewZoom !== 'fit') {
            e.preventDefault();
        }
    });
}

// ========================================
// Preview Zoom (like Premiere Pro Program Monitor)
// ========================================
function setupPreviewZoom() {
    const select = elements.previewZoomSelect;
    if (!select) return;

    select.addEventListener('change', (e) => {
        const val = e.target.value;
        setPreviewZoom(val === 'fit' ? 'fit' : parseInt(val));
    });
}

function setPreviewZoom(zoom) {
    state.previewZoom = zoom;

    const container = elements.previewContainer;
    const videoFrame = elements.videoContainer;
    if (!container || !videoFrame) return;

    // Update label
    if (elements.previewZoomLabel) {
        elements.previewZoomLabel.textContent = zoom === 'fit' ? 'Fit' : `${zoom}%`;
    }

    // Update dropdown to closest preset
    if (elements.previewZoomSelect) {
        const presets = [25, 50, 75, 100, 150, 200];
        if (zoom === 'fit') {
            elements.previewZoomSelect.value = 'fit';
        } else {
            // Find closest preset
            const closest = presets.reduce((prev, curr) =>
                Math.abs(curr - zoom) < Math.abs(prev - zoom) ? curr : prev
            );
            // Only update if exact match, otherwise leave dropdown as is
            if (presets.includes(zoom)) {
                elements.previewZoomSelect.value = String(zoom);
            }
        }
    }

    if (zoom === 'fit') {
        // Fit mode: 16:9 frame fills available space
        container.classList.remove('zoomed');
        videoFrame.style.width = '';
        videoFrame.style.height = '';
        videoFrame.style.minWidth = '';
        videoFrame.style.minHeight = '';
    } else {
        // Specific zoom %: actual pixel size relative to 1920x1080
        const w = Math.round(1920 * zoom / 100);
        const h = Math.round(1080 * zoom / 100);
        container.classList.add('zoomed');
        videoFrame.style.width = `${w}px`;
        videoFrame.style.height = `${h}px`;
        videoFrame.style.minWidth = `${w}px`;
        videoFrame.style.minHeight = `${h}px`;

        // Center scroll position (only on first zoom, not during pan)
        requestAnimationFrame(() => {
            container.scrollLeft = (container.scrollWidth - container.clientWidth) / 2;
            container.scrollTop = (container.scrollHeight - container.clientHeight) / 2;
        });
    }
}

// ========================================
// Save Project
// ========================================
async function saveProject(silent = false) {
    if (!state.videoPlan) {
        if (!silent) showToast('No project to save', 'info');
        return;
    }
    try {
        // Update the plan with current scene state
        state.videoPlan.scenes = state.scenes.filter(s => !s.isMGScene).map((s, i) => ({
            ...s,
            index: i,
            originalStartTime: s.originalStartTime,
            originalEndTime: s.originalEndTime
        }));
        state.videoPlan.mgScenes = state.scenes.filter(s => s.isMGScene && !s.disabled).map(s => ({ ...s }));
        state.videoPlan.mutedTracks = { ...state.mutedTracks };
        state.videoPlan.totalDuration = state.totalDuration;
        state.videoPlan.transitionStyle = elements.transitionStyle.value;

        // Collect current editor settings
        const settings = {
            aiProvider: elements.aiProvider.value,
            transitionStyle: elements.transitionStyle.value,
            transitionDuration: state.transition.duration,
            volume: state.volume,
            footageSources: getEnabledSources(),
            sfxEnabled: state.sfxEnabled,
            sfxVolume: state.sfxVolume,
            mgEnabled: state.mgEnabled,
            subtitlesEnabled: state.subtitlesEnabled,
            aiInstructions: state.aiInstructions,
            mutedTracks: state.mutedTracks
        };

        // Save as .fvp project file (includes settings + video plan + writes video-plan.json for Remotion)
        if (window.electronAPI.saveProjectFile) {
            const result = await window.electronAPI.saveProjectFile({ settings, videoPlan: state.videoPlan });
            state.hasProjectFile = true;
            if (!silent && result && result.path) {
                showToast(`Project saved to ${result.path}`, 'success');
            } else if (!silent) {
                showToast('Project saved', 'success');
            }
        } else {
            // Fallback: old save method
            await window.electronAPI.saveVideoPlan(state.videoPlan);
            if (!silent) showToast('Project saved', 'success');
        }
    } catch (e) {
        console.error('Save failed:', e);
        if (!silent) showToast('Save failed', 'error');
    }
}

// Debounced auto-save: saves .fvp file 3 seconds after last change
let _autoSaveTimer = null;
function triggerAutoSave() {
    if (!state.hasProjectFile || !state.videoPlan) return;
    if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(() => {
        saveProject(true); // silent save
    }, 3000);
}

function togglePlayback() {
    if (state.scenes.length === 0) return;

    if (state.isPlaying) {
        stopPlayback();
    } else {
        startPlayback();
    }
}

function startPlayback() {
    if (state.isPlaying) return;

    // If at the end, restart from beginning
    if (state.currentTime >= state.totalDuration) {
        state.currentTime = 0;
        state.currentSceneIndex = 0;
        jumpToScene(0).then(() => {
            actuallyStartPlayback();
        });
        return;
    }

    actuallyStartPlayback();
}

function actuallyStartPlayback() {
    const audio = elements.previewAudio;
    const activeScenes = getActiveScenesAtTime(state.currentTime);

    state.isPlaying = true;
    state.lastPlaybackTime = performance.now();

    // Update play button
    if (elements.btnPlay) {
        elements.btnPlay.textContent = '⏸';
    }

    // Start all active track videos
    if (activeScenes.length > 0) {
        activeScenes.forEach(({ scene }) => {
            const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
            const video = getActiveTrackVideo(trackNum);
            if (video && video.src) {
                video.play().catch(e => console.warn('Video play failed:', e));
            }
        });
    } else {
        // In a gap - show placeholder
        elements.videoContainer?.classList.add('hidden');
        elements.previewPlaceholder.classList.remove('hidden');
    }

    // Always start audio - it plays through gaps
    if (audio?.src) {
        audio.currentTime = Math.min(state.currentTime, audio.duration || state.totalDuration);
        audio.play().catch(e => console.warn('Audio play failed:', e));
    }

    // Start compositor videos if in compositor mode
    if (state.compositorActive && state.compositor) {
        state.compositor.playVideos(state.currentTime);
    }

    // Start the playback loop
    startPlaybackLoop();
}

function stopPlayback() {
    state.isPlaying = false;

    // Update play button
    if (elements.btnPlay) {
        elements.btnPlay.textContent = '▶';
    }

    // Cancel animation frame
    if (state.playbackAnimationFrame) {
        cancelAnimationFrame(state.playbackAnimationFrame);
        state.playbackAnimationFrame = null;
    }

    // Pause compositor videos
    if (state.compositor) state.compositor.pauseVideos();

    // Reset scene load flag and per-track swap flags
    state._sceneLoadPending = false;
    state._trackSwapPending = { '1': false, '2': false, '3': false };
    state._trackLastHardSyncMs = { '1': 0, '2': 0, '3': 0 };
    state.activeSceneIndices = [];
    state.activeOverlaySceneIndices = [];

    // Flush deferred bgVideo load
    if (elements.bgVideo && elements.bgVideo._pendingSrc) {
        elements.bgVideo.src = elements.bgVideo._pendingSrc;
        elements.bgVideo._pendingSrc = null;
        elements.bgVideo.load();
    }

    // Pause all track video elements (both A and B buffers)
    [elements.videoTrack1, elements.videoTrack2, elements.videoTrack3,
     elements.videoTrack1B, elements.videoTrack2B, elements.videoTrack3B,
     elements.videoTransitionOut].forEach(video => {
        if (video && !video.paused) {
            video.pause();
        }
        if (video) {
            video.playbackRate = 1;
        }
    });

    // Stop all SFX
    stopAllSfx();

    // Clean up any ongoing transition
    state.transition.isTransitioning = false;
    if (elements.videoTransitionOut) {
        resetVideoTransitionState(elements.videoTransitionOut);
        elements.videoTransitionOut.src = '';
        elements.videoTransitionOut.style.zIndex = '';
    }
    if (elements.imgTransitionOut) {
        elements.imgTransitionOut.classList.remove('incoming', 'outgoing', 'active');
        elements.imgTransitionOut.src = '';
        elements.imgTransitionOut.style.zIndex = '';
        elements.imgTransitionOut.style.opacity = '';
        elements.imgTransitionOut.style.transform = '';
        elements.imgTransitionOut.style.filter = '';
        elements.imgTransitionOut.style.clipPath = '';
        elements.imgTransitionOut.style.visibility = '';
    }
    if (elements.videoContainer) {
        elements.videoContainer.className = 'video-transition-container';
    }

    // Pause audio
    const audio = elements.previewAudio;
    if (audio && !audio.paused) {
        audio.pause();
    }
}


function startPlaybackLoop() {
    if (state.playbackAnimationFrame) {
        cancelAnimationFrame(state.playbackAnimationFrame);
    }

    const loop = () => {
        if (!state.isPlaying) return;

        const audio = elements.previewAudio;

        // === WebGL2 Compositor path (when active, bypasses HTML preview) ===
        if (state.compositorActive && state.compositor && state.compositor.isInitialized) {
            // Audio is still the master clock
            if (audio?.src && !audio.paused) {
                state.currentTime = audio.currentTime;
            }
            // Check end of timeline
            if (state.currentTime >= state.totalDuration) {
                state.currentTime = state.totalDuration;
                stopPlayback();
                updatePlayhead();
                updateTimeDisplay();
                return;
            }
            // Render the frame via WebGL2 engine
            state.compositor.renderAtTime(state.currentTime);
            // Sync audio
            if (audio?.src && !audio.paused) {
                const audioDiff = Math.abs(audio.currentTime - state.currentTime);
                if (audioDiff > 0.2) {
                    audio.currentTime = Math.min(state.currentTime, audio.duration || state.totalDuration);
                }
            }
            // Update UI (playhead, time, scene highlight)
            updatePlayhead();
            updateTimeDisplay();
            const activeScenes = getActiveScenesAtTime(state.currentTime);
            const activeMediaScenes = activeScenes.filter(({ scene }) => !scene.isMGScene && !scene.disabled);
            updateSceneHighlight(activeMediaScenes.length > 0 ? activeMediaScenes[0].index : -1);
            // Continue loop
            state.playbackAnimationFrame = requestAnimationFrame(loop);
            return;
        }

        // === Original HTML-based preview path ===
        const activeScenes = getActiveScenesAtTime(state.currentTime);
        const activeMediaScenes = activeScenes.filter(({ scene }) =>
            !scene.isMGScene && !scene.disabled
        );
        // Use audio as the master clock - it plays continuously through gaps
        if (audio?.src && !audio.paused) {
            state.currentTime = audio.currentTime;
        } else if (activeMediaScenes.length > 0) {
            // Use first active video as clock
            const firstScene = activeMediaScenes[0].scene;
            const trackNum = firstScene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
            const video = getActiveTrackVideo(trackNum);
            if (video && video.src && !video.paused) {
                state.currentTime = firstScene.startTime + video.currentTime - (firstScene.mediaOffset || 0);
            }
        }

        // Update time displays
        if (elements.currentTimeDisplay) {
            elements.currentTimeDisplay.textContent = formatTime(state.currentTime);
        }
        if (elements.totalTimeDisplay) {
            elements.totalTimeDisplay.textContent = formatTime(state.totalDuration);
        }

        // Check if we've reached the end of the timeline
        if (state.currentTime >= state.totalDuration) {
            state.currentTime = state.totalDuration;
            stopPlayback();
            updatePlayhead();
            updateTimeDisplay();
            return;
        }

        // Check if active scenes changed
        const mediaIndices = activeMediaScenes.map(s => s.index).join(',');
        const prevMediaIndices = (state.activeSceneIndices || []).join(',');
        const shouldReload = mediaIndices !== prevMediaIndices;

        if (shouldReload && !state._sceneLoadPending) {
            // Don't update activeSceneIndices yet — wait until load completes
            // This prevents the time sync from running on wrong video during load
            state._sceneLoadPending = true;
            loadActiveScenes(activeScenes).then(() => {
                state._sceneLoadPending = false;
                state.activeSceneIndices = activeMediaScenes.map(s => s.index);
                // After load completes, ensure videos are playing
                if (state.isPlaying) {
                    getActiveScenesAtTime(state.currentTime).forEach(({ scene }) => {
                        if (scene.mediaType === 'image' || scene.isMGScene) return;
                        const tn = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
                        const vid = getActiveTrackVideo(tn);
                        if (vid && vid.paused && vid.src) {
                            vid.play().catch(() => {});
                        }
                    });
                }
                // Immediately preload the NEXT scene after this one finishes loading
                preloadUpcomingScenes(state.currentTime, true);
            }).catch(e => {
                state._sceneLoadPending = false;
                console.error('Scene load error:', e);
            });
        } else if (!shouldReload) {
            // Only sync time when loaded scenes MATCH expected scenes
            const now = performance.now();
            activeMediaScenes.forEach(({ scene }) => {
                const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
                // Skip tracks with a deferred swap in progress — old clip plays naturally
                if (state._trackSwapPending[trackNum]) return;
                const isImage = scene.mediaType === 'image';
                if (isImage) {
                    // Update Ken Burns transform every frame for smooth animation
                    const img = elements[`imgTrack${trackNum}`];
                    if (img) {
                        updateKenBurnsTransform(img, scene);
                    }
                } else {
                    const video = getActiveTrackVideo(trackNum);
                    if (video && !video.paused) {
                        const sceneTime = (state.currentTime - scene.startTime) + (scene.mediaOffset || 0);
                        const drift = sceneTime - video.currentTime;
                        const absDrift = Math.abs(drift);
                        const lastHardSync = state._trackLastHardSyncMs[trackNum] || 0;

                        // Avoid frequent hard seeks: they cause visible stutter.
                        // Hard-seek only for large drift, otherwise gently nudge playbackRate.
                        if (absDrift > 0.35 || (absDrift > 0.18 && now - lastHardSync > 500)) {
                            video.currentTime = Math.max(0, sceneTime);
                            state._trackLastHardSyncMs[trackNum] = now;
                            video.playbackRate = 1;
                        } else if (absDrift > 0.05) {
                            const correction = Math.max(-0.08, Math.min(0.08, drift * 0.35));
                            video.playbackRate = 1 + correction;
                        } else if (video.playbackRate !== 1) {
                            video.playbackRate = 1;
                        }
                    }
                }
            });
        }
        // else: shouldReload BUT _sceneLoadPending — skip both branches
        // Old clip continues playing naturally until new clip is loaded

        // Sync audio to current time (with tolerance)
        if (audio?.src && !audio.paused) {
            const audioDiff = Math.abs(audio.currentTime - state.currentTime);
            if (audioDiff > 0.2) {
                audio.currentTime = Math.min(state.currentTime, audio.duration || state.totalDuration);
            }
        }

        // Trigger SFX clips at transition points
        if (state.sfxEnabled && state.sfxClips.length > 0) {
            const ct = state.currentTime;
            state.sfxClips.forEach(sfx => {
                const sfxEnd = sfx.startTime + sfx.duration;
                if (ct >= sfx.startTime && ct < sfxEnd && !sfx._triggered) {
                    sfx._triggered = true;
                    playSfxClip(sfx);
                }
                if (ct < sfx.startTime || ct >= sfxEnd) {
                    sfx._triggered = false;
                }
            });
        }

        // Preload upcoming scenes' media URLs (fire-and-forget)
        preloadUpcomingScenes(state.currentTime);

        // Update UI (all optimized: cached DOM lookups, skipped when unchanged)
        updatePlayhead();
        updateTimeDisplay();
        updateSceneHighlight(activeMediaScenes.length > 0 ? activeMediaScenes[0].index : -1);
        updateMGOverlay();

        // Continue loop
        state.playbackAnimationFrame = requestAnimationFrame(loop);
    };

    state.playbackAnimationFrame = requestAnimationFrame(loop);
}

function playSfxClip(sfx) {
    if (!state.sfxEnabled || state.isMuted) return;
    const poolEntry = state._sfxAudioPool.find(p => !p.playing) || state._sfxAudioPool[0];
    if (!poolEntry) return;
    const audio = poolEntry.element;
    poolEntry.playing = true;

    window.electronAPI.getSfxPath(sfx.file).then(url => {
        if (!url) { poolEntry.playing = false; return; }
        audio.src = url;
        audio.volume = sfx.volume * state.volume;
        audio.currentTime = 0;
        audio.play().catch(() => {});
        audio.onended = () => { poolEntry.playing = false; };
        setTimeout(() => { poolEntry.playing = false; }, (sfx.duration + 0.5) * 1000);
    }).catch(() => { poolEntry.playing = false; });
}

function stopAllSfx() {
    state.sfxClips.forEach(sfx => { sfx._triggered = false; });
    state._sfxAudioPool.forEach(p => {
        p.element.pause();
        p.element.currentTime = 0;
        p.playing = false;
    });
}

/**
 * Update the Motion Graphics overlay in the preview.
 * Shows/hides MG elements based on current playback time.
 */
// Full-screen MG preview for V3 scenes (opaque background + centered content)
function renderFullscreenMGPreview(scene) {
    const mg = scene.mgData || scene;
    const mgStyleName = mg.style || scene.style || state.mgStyle || 'clean';
    const styledColors = getStyledThemeColors(mgStyleName);
    const baseS = MG_STYLES[mgStyleName] || MG_STYLES.clean;
    const s = styledColors ? { ...baseS, ...styledColors } : baseS;
    const tf = getActiveThemeFonts();
    // Replace double quotes with single quotes in font names to avoid breaking style="" attribute
    const fontH = tf.heading.replace(/"/g, "'");
    const fontB = tf.body.replace(/"/g, "'");
    const styleVars = `--mg-primary:${s.primary};--mg-accent:${s.accent};--mg-bg:${s.bg};--mg-text:${s.text};--mg-text-sub:${s.textSub};--mg-font-heading:${fontH};--mg-font-body:${fontB}`;

    const elapsed = Math.max(0, state.currentTime - (mg.startTime || scene.startTime));
    const duration = mg.duration || (scene.endTime - scene.startTime);
    const enterDur = Math.min(0.5, duration * 0.35);
    const exitDur = Math.min(0.3, duration * 0.2);
    const isExiting = elapsed > duration - exitDur;
    const opacity = isExiting ? Math.max(0, (duration - elapsed) / exitDur) : Math.min(1, elapsed / enterDur);
    const enterDone = elapsed >= enterDur;
    const type = mg.type || scene.type;

    // Background gradients per style
    const bgGradients = {
        clean:    'radial-gradient(ellipse at center, #0a0a2e, #000000)',
        bold:     'radial-gradient(ellipse at center, #1a0000, #0a0a0a)',
        minimal:  'radial-gradient(ellipse at center, #1a1a2e, #0f0f0f)',
        neon:     'radial-gradient(ellipse at center, #000020, #000008)',
        cinematic:'radial-gradient(ellipse at center, #1a1500, #000000)',
        elegant:  'radial-gradient(ellipse at center, #0a0020, #050010)',
    };
    const bgGrad = bgGradients[mg.style || scene.style] || bgGradients.clean;

    let innerHtml = '';
    switch (type) {
        case 'barChart': {
            const items = parseKeyValuePairs(mg.subtext || scene.subtext);
            const maxVal = Math.max(...items.map(i => parseFloat(i.value) || 0), 1);
            const barsHTML = items.slice(0, 6).map((item, i) => {
                const barProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.3 - i * 0.15) / 0.5));
                const barEased = 1 - Math.pow(1 - barProg, 3);
                const heightPct = ((parseFloat(item.value) || 0) / maxVal) * 100 * barEased;
                return `<div class="mg-bar-col">
                    <div class="mg-bar-value" style="opacity:${Math.min(1, Math.max(0, barProg - 0.3))}">${escapeHTML(item.value)}</div>
                    <div class="mg-bar" style="height:${heightPct}%"></div>
                    <div class="mg-bar-label">${escapeHTML(item.label)}</div>
                </div>`;
            }).join('');
            innerHtml = `<div class="mg-preview-element mg-bar-chart mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-chart-title">${escapeHTML(mg.text || scene.text)}</div>
                <div class="mg-bars-container">${barsHTML}</div>
            </div>`;
            break;
        }
        case 'donutChart': {
            const items = parseKeyValuePairs(mg.subtext || scene.subtext);
            const total = items.reduce((sum, i) => sum + (parseFloat(i.value) || 0), 0) || 100;
            const legendHTML = items.slice(0, 5).map((item, i) => {
                const itemOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.5 - i * 0.12) / 0.2));
                return `<div class="mg-donut-legend-item" style="opacity:${itemOp}">
                    <span class="mg-donut-dot" style="background:${i === 0 ? 'var(--mg-primary)' : 'var(--mg-accent)'}"></span>
                    ${escapeHTML(item.label)} ${escapeHTML(item.value)}%
                </div>`;
            }).join('');
            let gradientStops = [], cumPct = 0;
            const colors = ['var(--mg-primary)', 'var(--mg-accent)', 'rgba(255,255,255,0.3)', 'rgba(255,255,255,0.15)'];
            items.slice(0, 5).forEach((item, i) => {
                const pct = (parseFloat(item.value) || 0) / total * 100;
                const drawProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.2 - i * 0.2) / 0.5));
                const drawnPct = pct * (1 - Math.pow(1 - drawProg, 3));
                gradientStops.push(`${colors[i % colors.length]} ${cumPct}% ${cumPct + drawnPct}%`);
                cumPct += drawnPct;
            });
            gradientStops.push(`transparent ${cumPct}% 100%`);
            innerHtml = `<div class="mg-preview-element mg-donut-chart mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-chart-title">${escapeHTML(mg.text || scene.text)}</div>
                <div class="mg-donut-row">
                    <div class="mg-donut-ring" style="background:conic-gradient(from 0deg, ${gradientStops.join(', ')})"><div class="mg-donut-hole"></div></div>
                    <div class="mg-donut-legend">${legendHTML}</div>
                </div>
            </div>`;
            break;
        }
        case 'comparisonCard': {
            const parts = (mg.text || scene.text).split(/\s+vs\.?\s+/i);
            const slideAmt = enterDone ? 0 : (1 - elapsed / enterDur) * 30;
            const vsProg = Math.min(1, Math.max(0, (elapsed - 0.3) / 0.3));
            innerHtml = `<div class="mg-preview-element mg-comparison mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-comp-panel mg-comp-left" style="transform:translateX(${-slideAmt}px)">${escapeHTML(parts[0] || 'A')}</div>
                <div class="mg-comp-vs" style="transform:scale(${vsProg})">VS</div>
                <div class="mg-comp-panel mg-comp-right" style="transform:translateX(${slideAmt}px)">${escapeHTML(parts[1] || 'B')}</div>
            </div>`;
            break;
        }
        case 'timeline': {
            const items = parseKeyValuePairs(mg.subtext || scene.subtext);
            const lineW = enterDone ? 100 : Math.min(100, elapsed / enterDur * 100);
            const markersHTML = items.slice(0, 5).map((item, i) => {
                const pct = items.length > 1 ? (i / (items.length - 1)) * 100 : 50;
                const mOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.3 - i * 0.25) / 0.25));
                return `<div class="mg-tl-marker" style="left:${pct}%;opacity:${mOp}">
                    <div class="mg-tl-year">${escapeHTML(item.label)}</div>
                    <div class="mg-tl-dot"></div>
                    <div class="mg-tl-event">${escapeHTML(item.value)}</div>
                </div>`;
            }).join('');
            innerHtml = `<div class="mg-preview-element mg-timeline mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-chart-title">${escapeHTML(mg.text || scene.text)}</div>
                <div class="mg-tl-container">
                    <div class="mg-tl-line" style="width:${lineW}%"></div>
                    ${markersHTML}
                </div>
            </div>`;
            break;
        }
        case 'rankingList': {
            const items = parseKeyValuePairs(mg.subtext || scene.subtext);
            const maxVal = Math.max(...items.map(i => parseFloat(i.value) || 0), 1);
            const rowsHTML = items.slice(0, 6).map((item, i) => {
                const rowOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.2 - i * 0.18) / 0.25));
                const barProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.35 - i * 0.18) / 0.5));
                const barW = (1 - Math.pow(1 - barProg, 3)) * ((parseFloat(item.value) || 0) / maxVal) * 100;
                return `<div class="mg-rank-row" style="opacity:${rowOp}">
                    <span class="mg-rank-num ${i === 0 ? 'mg-rank-top' : ''}">${i + 1}</span>
                    <div class="mg-rank-content">
                        <div class="mg-rank-header"><span>${escapeHTML(item.label)}</span><span class="mg-rank-val">${escapeHTML(item.value)}</span></div>
                        <div class="mg-rank-track"><div class="mg-rank-bar ${i === 0 ? 'mg-rank-bar-top' : ''}" style="width:${barW}%"></div></div>
                    </div>
                </div>`;
            }).join('');
            innerHtml = `<div class="mg-preview-element mg-ranking mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-chart-title">${escapeHTML(mg.text || scene.text)}</div>
                ${rowsHTML}
            </div>`;
            break;
        }
        case 'bulletList': {
            const bulletItems = (mg.text || scene.text).split(/[,;]|\d+\.\s/).filter(s => s.trim());
            const bulletsHTML = bulletItems.map((item, i) => {
                const bOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.2 - i * 0.2) / 0.3));
                return `<div class="mg-bullet-item" style="opacity:${bOp}"><span class="mg-bullet-marker">▸</span>${escapeHTML(item.trim())}</div>`;
            }).join('');
            innerHtml = `<div class="mg-preview-element mg-bullets-list mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-chart-title">${escapeHTML(mg.text || scene.text)}</div>
                ${bulletsHTML}
            </div>`;
            break;
        }
        case 'mapChart': {
            // Map visual style presets (matches MotionGraphics.jsx MAP_VISUAL_STYLES)
            const MAP_PREVIEW_STYLES = {
                dark:      { ocean: '#0a1628', land: '#1a2744', border: 'rgba(30,58,95,0.4)', marker: null, label: null, labelBg: null, grid: true },
                natural:   { ocean: '#1a4a6e', land: '#3a6b4a', border: 'rgba(42,80,56,0.4)', marker: '#ffffff', label: '#ffffff', labelBg: 'rgba(15,30,20,0.88)', grid: false },
                satellite: { ocean: '#050d1a', land: '#141e14', border: 'rgba(26,48,32,0.3)', marker: '#00ffcc', label: '#ffffff', labelBg: 'rgba(5,10,15,0.9)', grid: false },
                light:     { ocean: '#d4e6f1', land: '#ecf0f1', border: 'rgba(189,195,199,0.6)', marker: '#e74c3c', label: '#2c3e50', labelBg: 'rgba(255,255,255,0.92)', grid: true },
                political: { ocean: '#b8d4e8', land: '#f0e6d3', border: 'rgba(138,122,106,0.5)', marker: '#c0392b', label: '#2c1810', labelBg: 'rgba(240,230,211,0.92)', grid: true },
            };
            const mps = MAP_PREVIEW_STYLES[mg.mapStyle || 'dark'] || MAP_PREVIEW_STYLES.dark;

            // Country coordinate lookup for geographic positioning
            const MAP_COORDS = {
                'China': [104, 35], 'United States': [-98, 39], 'USA': [-98, 39],
                'India': [78, 22], 'Japan': [138, 36], 'Germany': [10.5, 51.2],
                'United Kingdom': [-2, 54], 'UK': [-2, 54], 'France': [2.2, 46.2],
                'Brazil': [-51, -10], 'Italy': [12.5, 42.5], 'Canada': [-106, 56],
                'Russia': [100, 60], 'South Korea': [128, 36], 'Australia': [134, -25],
                'Spain': [-3.7, 40.4], 'Mexico': [-102, 23], 'Indonesia': [118, -2],
                'Norway': [9, 62], 'Turkey': [35, 39], 'Saudi Arabia': [45, 24],
                'South Africa': [25, -29], 'Argentina': [-64, -34], 'Nigeria': [8, 10],
                'Egypt': [30, 27], 'Thailand': [101, 15], 'Vietnam': [108, 16],
                'Iran': [53, 32], 'Colombia': [-74, 4], 'Chile': [-71, -35],
                'Pakistan': [70, 30], 'Philippines': [122, 13], 'Malaysia': [110, 4],
                'Ukraine': [32, 49], 'Kenya': [38, 0], 'Morocco': [-5, 32],
                'Myanmar': [96, 20], 'Taiwan': [121, 24], 'Afghanistan': [67, 33],
            };
            const items = parseKeyValuePairs(mg.subtext || scene.subtext);
            // Equirectangular projection: lng/lat → x%/y%
            const pinPositions = items.slice(0, 8).map((item, i) => {
                const coords = MAP_COORDS[item.label];
                let x, y;
                if (coords) {
                    x = ((coords[0] + 180) / 360) * 85 + 7;
                    y = ((90 - coords[1]) / 180) * 80 + 5;
                } else {
                    const hash = (item.label || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
                    x = 12 + ((hash * 7 + i * 137) % 76);
                    y = 15 + ((hash * 13 + i * 89) % 60);
                }
                return { ...item, x, y, i };
            });
            const pinColor = mps.marker || 'var(--mg-accent)';
            const pinLabelColor = mps.label || 'var(--mg-text)';
            const pinLabelBg = mps.labelBg || 'var(--mg-bg)';
            const pinsHTML = pinPositions.map((pin) => {
                const pinOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.3 - pin.i * 0.2) / 0.3));
                const bounce = pinOp < 1 ? (1 - pinOp) * 10 : 0;
                return `<div class="mg-map-pin" style="left:${pin.x}%;top:${pin.y}%;opacity:${pinOp};transform:translateY(${-bounce}px)">
                    <div class="mg-map-pin-dot" style="background:${pinColor};box-shadow:0 0 8px ${pinColor}"></div>
                    <div class="mg-map-pin-label" style="color:${pinLabelColor};background:${pinLabelBg}">${escapeHTML(pin.label)}</div>
                    ${pin.value && pin.value !== '0' ? `<div class="mg-map-pin-value" style="color:${pinColor}">${escapeHTML(pin.value)}</div>` : ''}
                </div>`;
            }).join('');
            const gridHTML = mps.grid ? `<div class="mg-map-grid" style="background:linear-gradient(90deg, ${mps.border} 1px, transparent 1px), linear-gradient(0deg, ${mps.border} 1px, transparent 1px);background-size:20% 25%"></div>` : '';
            // Map-specific background (ocean + land representation)
            const mapBg = `radial-gradient(ellipse at center, ${mps.ocean}, ${mps.ocean})`;
            const containerBg = `radial-gradient(ellipse 60% 50% at center, ${mps.land}60, transparent)`;
            innerHtml = `<div class="mg-preview-element mg-map-chart mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-chart-title" style="color:${pinLabelColor}">${escapeHTML(mg.text || scene.text)}</div>
                <div class="mg-map-container" style="background:${containerBg};border-color:${mps.border}">
                    ${gridHTML}
                    ${pinsHTML}
                </div>
            </div>`;
            // Override bgGrad for map to use ocean color
            innerHtml = `<div class="mg-fullscreen-bg" style="${styleVars};background:${mapBg}">${innerHtml}</div>`;
            // Return early since we handle the wrapper ourselves
            return innerHtml;
        }
        case 'articleHighlight': {
            // IMAGE MODE: real article screenshot with highlight boxes
            const articleImgUrl = mg._articleImageUrl || scene._articleImageUrl;
            const hlBoxes = mg.highlightBoxes || scene.highlightBoxes || [];
            if (articleImgUrl) {
                const blurAmt = Math.max(0, 12 - elapsed * 12);
                const cardScale = 1 + elapsed * 0.01;
                const rotY = elapsed / (mg.duration || 7) * 6;
                // Build yellow highlighter marker overlays (staggered sweep per phrase)
                let boxesHtml = '';
                for (let bi = 0; bi < hlBoxes.length; bi++) {
                    const b = hlBoxes[bi];
                    const yOff = (bi % 2 === 0) ? 0.3 : -0.2;
                    const rot = (bi % 2 === 0) ? -0.3 : 0.4;
                    const sweepProg = Math.min(1, Math.max(0, (elapsed - 1.2 - bi * 0.3) / 0.5));
                    const sweepEased = 1 - Math.pow(1 - sweepProg, 2.5);
                    if (sweepEased > 0) {
                        boxesHtml += `<div style="position:absolute;left:${(b.x - 1).toFixed(1)}%;top:${(b.y + yOff).toFixed(1)}%;width:${(b.w + 2).toFixed(1)}%;height:${Math.max(b.h, 3.8).toFixed(1)}%;background:rgba(255,230,0,0.38);border-radius:3px;transform:rotate(${rot}deg);mix-blend-mode:multiply;clip-path:inset(0 ${((1 - sweepEased) * 100).toFixed(1)}% 0 0);pointer-events:none"></div>`;
                    }
                }
                innerHtml = `<div class="mg-preview-element mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity};filter:blur(${blurAmt > 0.1 ? blurAmt : 0}px);transform:scale(${cardScale.toFixed(3)}) perspective(1200px) rotateY(${rotY.toFixed(2)}deg)">
                    <div style="position:relative;border-radius:12px;overflow:hidden;box-shadow:0 20px 80px rgba(0,0,0,0.35)">
                        <img src="${articleImgUrl}" style="display:block;width:100%;height:auto;max-height:100%" />
                        ${boxesHtml}
                        <div style="position:absolute;inset:0;background:radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.35) 100%);pointer-events:none"></div>
                    </div>
                </div>`;
                break;
            }
            // HTML CARD MODE (fallback): generated article card
            const rawSub = mg.subtext || scene.subtext || '';
            const pipeParts = rawSub.split('|');
            let artSource = '', artAuthor = '', artDate = '', rawExcerpt = '';
            if (pipeParts.length >= 4) {
                artSource = (pipeParts[0] || '').trim();
                artAuthor = (pipeParts[1] || '').trim();
                artDate = (pipeParts[2] || '').trim();
                rawExcerpt = pipeParts.slice(3).join('|').trim();
            } else if (pipeParts.length === 3) {
                artSource = (pipeParts[0] || '').trim();
                if (/\d{4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(pipeParts[1])) {
                    artDate = (pipeParts[1] || '').trim();
                } else {
                    artAuthor = (pipeParts[1] || '').trim();
                }
                rawExcerpt = (pipeParts[2] || '').trim();
            } else if (pipeParts.length === 2) {
                artSource = (pipeParts[0] || '').trim();
                rawExcerpt = (pipeParts[1] || '').trim();
            } else {
                // No pipes — entire subtext is excerpt
                rawExcerpt = rawSub.trim();
            }
            // Extract highlighted phrases and build excerpt HTML
            const highlightPhrases = [];
            rawExcerpt.replace(/\*\*([^*]+)\*\*/g, (_, p) => highlightPhrases.push(p));
            // Auto-highlight if no ** markers: highlight numbers and key terms
            if (highlightPhrases.length === 0 && rawExcerpt.length > 0) {
                const numMatches = [];
                rawExcerpt.replace(/\d[\d,.]*\s*(?:%|percent|million|billion|trillion|thousand)?/gi, (m) => { numMatches.push(m.trim()); });
                if (numMatches.length > 0) {
                    numMatches.slice(0, 3).forEach(m => highlightPhrases.push(m));
                } else {
                    const common = new Set(['the','and','for','are','but','not','you','all','can','had','was','one','our','has','with','that','this','from','they','been','have','many','some','them','than','its','over','also','each','which','their','will','there','then','about','would','these','could','after','where']);
                    const words = rawExcerpt.split(/\s+/).filter(w => w.replace(/[^a-zA-Z]/g, '').length >= 4 && !common.has(w.toLowerCase().replace(/[^a-z]/g, '')));
                    words.sort((a, b) => b.length - a.length);
                    words.slice(0, 2).forEach(w => highlightPhrases.push(w));
                }
            }
            let excerptHTML = escapeHTML(rawExcerpt.replace(/\*\*([^*]+)\*\*/g, '$1'));
            for (let hi = 0; hi < highlightPhrases.length; hi++) {
                const phrase = escapeHTML(highlightPhrases[hi]);
                const sweepProg = Math.min(1, Math.max(0, (elapsed - 1.2 - hi * 0.4) / 0.5));
                const sweepEased = 1 - Math.pow(1 - sweepProg, 2);
                const sweepW = Math.round(sweepEased * 100);
                excerptHTML = excerptHTML.replace(phrase,
                    `<span class="mg-article-hl-wrap"><span class="mg-article-hl-bg" style="width:${sweepW}%"></span><strong>${phrase}</strong></span>`
                );
            }
            const blurAmt = Math.max(0, 12 - elapsed * 12);
            const cardScale = 1 + elapsed * 0.01;
            const byline = (artAuthor ? `By ${escapeHTML(artAuthor)}` : '') + (artAuthor && artDate ? '  \u00B7  ' : '') + escapeHTML(artDate);
            innerHtml = `<div class="mg-preview-element mg-article-card mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity};filter:blur(${blurAmt > 0.1 ? blurAmt : 0}px);transform:scale(${cardScale.toFixed(3)})">
                ${artSource ? `<div class="mg-article-source">${escapeHTML(artSource)}</div>` : ''}
                <div class="mg-article-headline">${escapeHTML(mg.text || scene.text)}</div>
                <div class="mg-article-sep" style="width:${Math.min(100, enterDone ? 100 : elapsed / enterDur * 100)}%"></div>
                ${byline ? `<div class="mg-article-byline">${byline}</div>` : ''}
                ${rawExcerpt ? `<div class="mg-article-excerpt">\u201C${excerptHTML}\u201D</div>` : ''}
            </div>`;
            break;
        }
        default:
            innerHtml = `<div class="mg-preview-element mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-chart-title">${escapeHTML(mg.text || scene.text || type)}</div>
            </div>`;
    }

    return `<div class="mg-fullscreen-bg" style="${styleVars};background:${bgGrad}">${innerHtml}</div>`;
}

// Throttled MG overlay — only rebuilds innerHTML when active MG set changes,
// uses lightweight style updates for per-frame animation (opacity, counters)
let _mgLastActiveIds = '';
let _mgLastUpdateTime = 0;
let _mgLastHtml = '';
const _MG_ANIMATION_INTERVAL = 120; // ms between MG redraws (lower CPU -> smoother video preview)

function updateMGOverlay() {
    const overlay = elements.mgOverlay;
    if (!overlay) return;

    if (!state.mgEnabled || !state.motionGraphics || state.motionGraphics.length === 0) {
        if (overlay.children.length > 0) overlay.innerHTML = '';
        _mgLastActiveIds = '';
        _mgLastHtml = '';
        return;
    }

    const ct = state.currentTime;
    const activeMGs = state.motionGraphics.filter(mg =>
        !mg.disabled && ct >= mg.startTime && ct < mg.startTime + mg.duration
    );

    if (activeMGs.length === 0) {
        if (overlay.children.length > 0) overlay.innerHTML = '';
        _mgLastActiveIds = '';
        _mgLastHtml = '';
        return;
    }

    // Check if active MG set changed (new MG appeared/disappeared)
    const currentIds = activeMGs.map(mg => `${mg.type}:${mg.startTime}`).join('|');
    const setChanged = currentIds !== _mgLastActiveIds;
    _mgLastActiveIds = currentIds;

    // Throttle animation updates to ~20fps (full rebuilds always run)
    const now = performance.now();
    if (!setChanged && now - _mgLastUpdateTime < _MG_ANIMATION_INTERVAL) return;
    _mgLastUpdateTime = now;

    // Build HTML for active MG elements
    const tf = getActiveThemeFonts();
    // Replace double quotes with single quotes in font names to avoid breaking style="" attribute
    const fontH = tf.heading.replace(/"/g, "'");
    const fontB = tf.body.replace(/"/g, "'");

    const html = activeMGs.map(mg => {
        // Per-MG style variables (with style-modified theme colors)
        const mgStyleName = mg.style || state.mgStyle || 'clean';
        const styledColors = getStyledThemeColors(mgStyleName);
        const baseS = MG_STYLES[mgStyleName] || MG_STYLES.clean;
        const s = styledColors ? { ...baseS, ...styledColors } : baseS;
        const styleVars = `--mg-primary:${s.primary};--mg-accent:${s.accent};--mg-bg:${s.bg};--mg-text:${s.text};--mg-text-sub:${s.textSub};--mg-font-heading:${fontH};--mg-font-body:${fontB}`;

        const elapsed = ct - mg.startTime;
        const enterDur = Math.min(0.5, mg.duration * 0.35);
        const exitDur = Math.min(0.3, mg.duration * 0.2);
        const isExiting = elapsed > mg.duration - exitDur;
        const opacity = isExiting
            ? Math.max(0, (mg.duration - elapsed) / exitDur)
            : Math.min(1, elapsed / enterDur);
        const enterDone = elapsed > enterDur;

        const posClass = `mg-pos-${mg.position || 'center'}`;

        switch (mg.type) {
            case 'headline':
                return `<div class="mg-preview-element mg-headline ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-headline-text">${escapeHTML(mg.text)}</div>
                    <div class="mg-headline-bar" style="width:${enterDone ? 100 : Math.min(100, elapsed / enterDur * 100)}%"></div>
                    ${mg.subtext && mg.subtext !== 'none' ? `<div class="mg-headline-sub">${escapeHTML(mg.subtext)}</div>` : ''}
                </div>`;

            case 'lowerThird':
                return `<div class="mg-preview-element mg-lower-third ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-lt-accent"></div>
                    <div class="mg-lt-content">
                        <div class="mg-lt-text">${escapeHTML(mg.text)}</div>
                        ${mg.subtext && mg.subtext !== 'none' ? `<div class="mg-lt-sub">${escapeHTML(mg.subtext)}</div>` : ''}
                    </div>
                </div>`;

            case 'statCounter': {
                const numMatch = mg.text.match(/[\d,.]+/);
                const target = numMatch ? parseFloat(numMatch[0].replace(/,/g, '')) : 0;
                const countProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.4) / 1.0));
                const eased = 1 - Math.pow(1 - countProg, 3);
                const current = target % 1 !== 0
                    ? (target * eased).toFixed(1)
                    : Math.round(target * eased).toLocaleString();
                const prefix = mg.text.substring(0, mg.text.indexOf(numMatch?.[0] || '')).trim();
                const suffix = mg.text.substring(mg.text.indexOf(numMatch?.[0] || '') + (numMatch?.[0]?.length || 0)).trim();
                return `<div class="mg-preview-element mg-stat ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-stat-number">${escapeHTML(prefix)}${current}</div>
                    <div class="mg-stat-label">${escapeHTML(suffix || mg.subtext || '')}</div>
                </div>`;
            }

            case 'callout':
                return `<div class="mg-preview-element mg-callout ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-callout-box">
                        <span class="mg-callout-quote">\u201C</span>
                        <p class="mg-callout-text">${escapeHTML(mg.text)}</p>
                        ${mg.subtext && mg.subtext !== 'none' ? `<p class="mg-callout-attr">\u2014 ${escapeHTML(mg.subtext)}</p>` : ''}
                    </div>
                </div>`;

            case 'bulletList': {
                const items = mg.text.split(/[,;]|\d+\.\s/).map(s => s.trim()).filter(Boolean);
                const staggerDelay = 0.25;
                const bulletsHTML = items.map((item, i) => {
                    const itemOpacity = Math.min(1, Math.max(0, (elapsed - enterDur * 0.2 - i * staggerDelay) / 0.3));
                    return `<div class="mg-bullet-item" style="opacity:${itemOpacity}">
                        <span class="mg-bullet-dot"></span>
                        <span>${escapeHTML(item)}</span>
                    </div>`;
                }).join('');
                return `<div class="mg-preview-element mg-bullets ${posClass}" style="${styleVars};opacity:${opacity}">
                    ${bulletsHTML}
                </div>`;
            }

            case 'focusWord': {
                const subHtml = mg.subtext && mg.subtext !== 'none'
                    ? `<div class="mg-focus-sub" style="opacity:${Math.min(1, Math.max(0, (elapsed - enterDur * 0.5) / 0.3))}">${escapeHTML(mg.subtext)}</div>` : '';
                return `<div class="mg-preview-element mg-focus-word ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-focus-scrim" style="opacity:${Math.min(1, elapsed / 0.15)}"></div>
                    <div class="mg-focus-text">${escapeHTML(mg.text)}</div>
                    ${subHtml}
                </div>`;
            }

            case 'progressBar': {
                const numMatch = mg.text.match(/[\d,.]+/);
                const targetPct = numMatch ? Math.min(100, parseFloat(numMatch[0].replace(/,/g, ''))) : 75;
                const label = mg.text.replace(/[\d,.]+%?/, '').trim() || mg.subtext || '';
                const fillProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.5) / 1.2));
                const fillEased = 1 - Math.pow(1 - fillProg, 3);
                const currentPct = Math.round(targetPct * fillEased);
                return `<div class="mg-preview-element mg-progress ${posClass}" style="${styleVars};opacity:${opacity}">
                    ${label ? `<div class="mg-progress-label">${escapeHTML(label)}</div>` : ''}
                    <div class="mg-progress-track"><div class="mg-progress-fill" style="width:${targetPct * fillEased}%"></div></div>
                    <div class="mg-progress-number">${currentPct}%</div>
                </div>`;
            }

            case 'barChart': {
                const items = parseKeyValuePairs(mg.subtext);
                const maxVal = Math.max(...items.map(i => parseFloat(i.value) || 0), 1);
                const barsHTML = items.slice(0, 6).map((item, i) => {
                    const barProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.3 - i * 0.15) / 0.5));
                    const barEased = 1 - Math.pow(1 - barProg, 3);
                    const heightPct = ((parseFloat(item.value) || 0) / maxVal) * 100 * barEased;
                    return `<div class="mg-bar-col">
                        <div class="mg-bar-value" style="opacity:${Math.min(1, Math.max(0, barProg - 0.3))}">${escapeHTML(item.value)}</div>
                        <div class="mg-bar" style="height:${heightPct}%"></div>
                        <div class="mg-bar-label">${escapeHTML(item.label)}</div>
                    </div>`;
                }).join('');
                return `<div class="mg-preview-element mg-bar-chart ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-chart-title">${escapeHTML(mg.text)}</div>
                    <div class="mg-bars-container">${barsHTML}</div>
                </div>`;
            }

            case 'donutChart': {
                const items = parseKeyValuePairs(mg.subtext);
                const total = items.reduce((sum, i) => sum + (parseFloat(i.value) || 0), 0) || 100;
                const legendHTML = items.slice(0, 5).map((item, i) => {
                    const itemOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.5 - i * 0.12) / 0.2));
                    return `<div class="mg-donut-legend-item" style="opacity:${itemOp}">
                        <span class="mg-donut-dot" style="background:${i === 0 ? 'var(--mg-primary)' : 'var(--mg-accent)'}"></span>
                        ${escapeHTML(item.label)} ${escapeHTML(item.value)}%
                    </div>`;
                }).join('');
                let gradientStops = [];
                let cumPct = 0;
                const colors = ['var(--mg-primary)', 'var(--mg-accent)', 'rgba(255,255,255,0.3)', 'rgba(255,255,255,0.15)'];
                items.slice(0, 5).forEach((item, i) => {
                    const pct = (parseFloat(item.value) || 0) / total * 100;
                    const drawProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.2 - i * 0.2) / 0.5));
                    const drawnPct = pct * (1 - Math.pow(1 - drawProg, 3));
                    gradientStops.push(`${colors[i % colors.length]} ${cumPct}% ${cumPct + drawnPct}%`);
                    cumPct += drawnPct;
                });
                gradientStops.push(`transparent ${cumPct}% 100%`);
                const conicGrad = `conic-gradient(from 0deg, ${gradientStops.join(', ')})`;
                return `<div class="mg-preview-element mg-donut-chart ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-chart-title">${escapeHTML(mg.text)}</div>
                    <div class="mg-donut-row">
                        <div class="mg-donut-ring" style="background:${conicGrad}"><div class="mg-donut-hole"></div></div>
                        <div class="mg-donut-legend">${legendHTML}</div>
                    </div>
                </div>`;
            }

            case 'comparisonCard': {
                const parts = mg.text.split(/\s+vs\.?\s+/i);
                const itemA = parts[0] || 'A';
                const itemB = parts[1] || 'B';
                const slideAmt = enterDone ? 0 : (1 - elapsed / enterDur) * 30;
                const vsProg = Math.min(1, Math.max(0, (elapsed - 0.3) / 0.3));
                return `<div class="mg-preview-element mg-comparison ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-comp-panel mg-comp-left" style="transform:translateX(${-slideAmt}px)">${escapeHTML(itemA)}</div>
                    <div class="mg-comp-vs" style="transform:scale(${vsProg})">VS</div>
                    <div class="mg-comp-panel mg-comp-right" style="transform:translateX(${slideAmt}px)">${escapeHTML(itemB)}</div>
                </div>`;
            }

            case 'timeline': {
                const items = parseKeyValuePairs(mg.subtext);
                const lineW = enterDone ? 100 : Math.min(100, elapsed / enterDur * 100);
                const markersHTML = items.slice(0, 5).map((item, i) => {
                    const pct = items.length > 1 ? (i / (items.length - 1)) * 100 : 50;
                    const mOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.3 - i * 0.25) / 0.25));
                    return `<div class="mg-tl-marker" style="left:${pct}%;opacity:${mOp}">
                        <div class="mg-tl-year">${escapeHTML(item.label)}</div>
                        <div class="mg-tl-dot"></div>
                        <div class="mg-tl-event">${escapeHTML(item.value)}</div>
                    </div>`;
                }).join('');
                return `<div class="mg-preview-element mg-timeline ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-chart-title">${escapeHTML(mg.text)}</div>
                    <div class="mg-tl-container">
                        <div class="mg-tl-line" style="width:${lineW}%"></div>
                        ${markersHTML}
                    </div>
                </div>`;
            }

            case 'rankingList': {
                const items = parseKeyValuePairs(mg.subtext);
                const maxVal = Math.max(...items.map(i => parseFloat(i.value) || 0), 1);
                const rowsHTML = items.slice(0, 6).map((item, i) => {
                    const rowOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.2 - i * 0.18) / 0.25));
                    const barProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.35 - i * 0.18) / 0.5));
                    const barW = (1 - Math.pow(1 - barProg, 3)) * ((parseFloat(item.value) || 0) / maxVal) * 100;
                    return `<div class="mg-rank-row" style="opacity:${rowOp}">
                        <span class="mg-rank-num ${i === 0 ? 'mg-rank-top' : ''}">${i + 1}</span>
                        <div class="mg-rank-content">
                            <div class="mg-rank-header"><span>${escapeHTML(item.label)}</span><span class="mg-rank-val">${escapeHTML(item.value)}</span></div>
                            <div class="mg-rank-track"><div class="mg-rank-bar ${i === 0 ? 'mg-rank-bar-top' : ''}" style="width:${barW}%"></div></div>
                        </div>
                    </div>`;
                }).join('');
                return `<div class="mg-preview-element mg-ranking ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-chart-title">${escapeHTML(mg.text)}</div>
                    ${rowsHTML}
                </div>`;
            }

            case 'kineticText': {
                const words = (mg.text || '').split(/\s+/).filter(Boolean);
                const wordsHTML = words.map((word, i) => {
                    const wOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.1 - i * 0.12) / 0.15));
                    const wScale = 1 + (1 - wOp) * 0.5;
                    return `<span class="mg-kinetic-word" style="opacity:${wOp};transform:scale(${wScale})">${escapeHTML(word)}</span>`;
                }).join('');
                const allWordsEnd = enterDur * 0.1 + words.length * 0.12 + 0.3;
                const attrOp = elapsed > allWordsEnd ? Math.min(1, (elapsed - allWordsEnd) / 0.3) : 0;
                const subHtml = mg.subtext && mg.subtext !== 'none'
                    ? `<div class="mg-kinetic-attr" style="opacity:${attrOp}">\u2014 ${escapeHTML(mg.subtext)}</div>` : '';
                return `<div class="mg-preview-element mg-kinetic ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-kinetic-scrim" style="opacity:${Math.min(0.3, elapsed * 2)}"></div>
                    <div class="mg-kinetic-words">${wordsHTML}</div>
                    ${subHtml}
                </div>`;
            }

            default:
                return '';
        }
    }).join('');

    if (html !== _mgLastHtml) {
        overlay.innerHTML = html;
        _mgLastHtml = html;
    }
}

function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Hard-cut transition between clips (no animation).
 */
async function performTrackTransition(trackVideo, transOut, sceneIndex, newVideoUrl, scene) {
    if (!trackVideo) return;
    trackVideo.pause();
    trackVideo.src = newVideoUrl;
    trackVideo.load();
    const sceneTime = (state.currentTime - scene.startTime) + (scene.mediaOffset || 0);
    trackVideo.currentTime = sceneTime;
    trackVideo.volume = getSceneVolume(scene);
    trackVideo.muted = false;
    trackVideo.classList.remove('outgoing');
    trackVideo.classList.add('active');
    applySceneTransformToVideo(trackVideo, scene);
    if (transOut) { transOut.pause(); transOut.src = ''; }
    state.transition.isTransitioning = false;
    if (state.isPlaying) trackVideo.play().catch(() => {});
}

/**
 * Hard-cut transition between images (no animation).
 */
async function performImageTransition(trackImg, transOutImg, scene, newImgUrl) {
    if (!trackImg) return;
    trackImg.src = newImgUrl;
    updateKenBurnsTransform(trackImg, scene);
    trackImg.classList.remove('outgoing');
    trackImg.classList.add('active');
    state.transition.isTransitioning = false;
}

// Helper to reset video element to clean state
function resetVideoTransitionState(videoElement) {
    if (!videoElement) return;
    videoElement.classList.remove('active', 'outgoing', 'incoming');
    videoElement.style.opacity = '';
    videoElement.style.transform = '';
    videoElement.style.filter = '';
    videoElement.style.clipPath = '';
    videoElement.style.visibility = '';
}

// Simple scene jump (no visual effects)
async function simpleTransitionToScene(nextIndex, wasPlaying) {
    [elements.videoTrack1, elements.videoTrack2, elements.videoTrack3,
     elements.videoTrack1B, elements.videoTrack2B, elements.videoTrack3B].forEach(video => {
        if (video && !video.paused) video.pause();
    });

    const nextScene = state.scenes[nextIndex];
    state.currentTime = nextScene.startTime;
    updateSceneHighlight(nextIndex);
    await loadActiveScenes();

    if (wasPlaying && state.isPlaying) {
        const activeScenes = getActiveScenesAtTime(state.currentTime);
        activeScenes.forEach(({ scene }) => {
            const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
            const video = getActiveTrackVideo(trackNum);
            if (video && video.src) video.play().catch(e => console.warn('Video play failed:', e));
        });
    }
}

// ========================================
// Resizable Panels
// ========================================
function setupResizablePanels() {
    setupPanelResize(elements.resizeLeft, 'left');
    setupPanelResize(elements.resizeRight, 'right');
    setupTimelineResize();
}

function setupPanelResize(handle, side) {
    if (!handle) return;
    let isDragging = false, startX = 0, startWidth = 0;
    handle.addEventListener('mousedown', (e) => {
        isDragging = true; startX = e.clientX;
        startWidth = (side === 'left' ? elements.leftPanel : elements.rightPanel).offsetWidth;
        document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const panel = side === 'left' ? elements.leftPanel : elements.rightPanel;
        const deltaX = e.clientX - startX;
        let newWidth = side === 'left' ? startWidth + deltaX : startWidth - deltaX;
        panel.style.width = `${Math.max(150, Math.min(400, newWidth))}px`;
    });
    document.addEventListener('mouseup', () => { if (isDragging) { isDragging = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; } });
}

function setupTimelineResize() {
    const handle = elements.resizeTimeline;
    if (!handle) return;
    let isDragging = false, startY = 0, startHeight = 0;
    handle.addEventListener('mousedown', (e) => {
        isDragging = true; startY = e.clientY; startHeight = elements.timelineContainer.offsetHeight;
        document.body.style.cursor = 'row-resize'; document.body.style.userSelect = 'none'; e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        elements.timelineContainer.style.height = `${Math.max(100, Math.min(400, startHeight + startY - e.clientY))}px`;
    });
    document.addEventListener('mouseup', () => { if (isDragging) { isDragging = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; } });
}

// ========================================
// Collapsible Panel Sections
// ========================================
function setupPanelSections() {
    document.querySelectorAll('.panel-section-header').forEach(header => {
        header.addEventListener('click', () => {
            const section = header.closest('.panel-section-collapsible');
            if (section) section.classList.toggle('collapsed');
        });
    });
}

// ========================================
// File Handling
// ========================================
function handleFileSelect(file) {
    if (!['.mp3', '.wav', 'audio/mpeg', 'audio/wav'].some(t => file.name.toLowerCase().endsWith(t) || file.type === t)) {
        showToast('Please select an MP3 or WAV file', 'error'); return;
    }
    // Use webUtils.getPathForFile for sandboxed Electron (file.path is unavailable in Electron 20+)
    const filePath = window.electronAPI?.getFilePath ? window.electronAPI.getFilePath(file) : (file.path || '');
    state.audioFile = { name: file.name, path: filePath };
    state.audioPath = filePath || file.name;
    elements.audioName.textContent = file.name;
    elements.audioInfo.classList.remove('hidden');
    elements.dropZone.style.display = 'none';
    elements.btnGenerate.disabled = false;
    showToast(`Audio loaded: ${file.name}`, 'success');
    loadAudioFile(filePath);
}

async function loadAudioFile(filePath) {
    if (!elements.previewAudio || !filePath) return;
    try {
        const audioUrl = window.electronAPI?.getFileUrl ? await window.electronAPI.getFileUrl(filePath) : filePath;
        if (audioUrl) {
            elements.previewAudio.src = audioUrl;
            elements.previewAudio.load();
            // Update totalDuration to include full audio length
            elements.previewAudio.addEventListener('loadedmetadata', () => {
                if (elements.previewAudio.duration && isFinite(elements.previewAudio.duration)) {
                    const scenesEnd = state.scenes.length > 0 ? Math.max(...state.scenes.map(s => s.endTime)) : 0;
                    state.totalDuration = Math.max(scenesEnd, elements.previewAudio.duration);
                    updateTimeDisplay();
                }
            }, { once: true });
        }
    } catch (e) { console.error('Failed to load audio:', e); }
}

function removeAudio() {
    state.audioFile = null; state.audioPath = null;
    elements.audioInfo.classList.add('hidden');
    elements.dropZone.style.display = 'block';
    elements.btnGenerate.disabled = true;
    elements.fileInput.value = '';
    clearScenes();
}

// ========================================
// Cancel Process
// ========================================
async function cancelProcess() {
    if (!state.isProcessing) return;
    elements.btnCancel.disabled = true;
    elements.btnCancel.textContent = 'Cancelling...';
    try {
        const result = await window.electronAPI?.cancelProcess();
        if (result?.success) {
            stopTimer();
            updateProgress(0, `⛔ ${result.message || 'Cancelled'}`);
            showToast('Process cancelled', 'error');
        }
    } catch (e) {
        console.error('Cancel error:', e);
    } finally {
        elements.btnCancel.disabled = false;
        elements.btnCancel.textContent = 'Cancel';
    }
}

// ========================================
// Video Generation
// ========================================
async function generateVideo() {
    if (!state.audioFile || state.isProcessing) return;
    if (!state.audioFile.path) {
        showToast('Audio file path is missing. Please re-import the audio file.', 'error'); return;
    }
    state.isProcessing = true; elements.btnGenerate.disabled = true; showProgress(true); startTimer();
    try {
        updateProgress(5, '📁 Copying audio file...');
        const copyResult = await window.electronAPI?.copyFile(state.audioFile.path, 'input');
        if (copyResult && !copyResult.success) {
            throw new Error(`Failed to copy audio: ${copyResult.error}`);
        }
        updateProgress(10, '🎙️ Transcribing audio with Whisper...');
        const audioFileName = state.audioFile.name || state.audioFile.path?.split(/[\\/]/).pop();
        const result = await window.electronAPI.runBuild({
            aiProvider: elements.aiProvider.value,
            ollamaModel: elements.ollamaModel?.value || 'gemma3:12b',
            ollamaVisionModel: elements.ollamaVisionModel?.value || 'llava',
            transitionStyle: elements.transitionStyle.value,
            audioFileName,
            footageSources: getEnabledSources(),
            aiInstructions: state.aiInstructions,
            buildQuality: elements.buildQuality.value,
            buildFormat: elements.buildFormat.value,
            buildTheme: elements.buildTheme.value
        });
        if (result.success) {
            updateProgress(90, '📋 Loading video plan...'); await loadVideoPlan({ freshBuild: true });
            state.hasProjectFile = true; // Enable auto-save for the new plan
            saveProject(true); // Save .fvp with the fresh build data
            stopTimer();
            const genTime = getElapsedString();
            updateProgress(100, `✅ Ready to render! (${genTime})`); showToast(`Video generated in ${genTime}!`, 'success');
            showNotification('Generation Complete', `Video generated in ${genTime}`);
            elements.btnRender.disabled = false;
            if (state.scenes.length > 0) await jumpToScene(0);
        } else {
            const errorMsg = result.error || 'Build failed';
            if (errorMsg === 'Cancelled') {
                stopTimer(); updateProgress(0, '⛔ Generation cancelled'); showToast('Generation cancelled', 'info'); showNotification('Generation Cancelled', `Stopped after ${getElapsedString()}`, 'cancel');
            } else {
                throw new Error(errorMsg);
            }
        }
    } catch (error) { console.error('❌ Generation error:', error); stopTimer(); showToast(`Error: ${error.message}`, 'error'); }
    finally { state.isProcessing = false; elements.btnGenerate.disabled = false; elements.btnCancel.disabled = false; elements.btnCancel.textContent = 'Cancel'; setTimeout(() => showProgress(false), 5000); }
}

// ========================================
// Video Plan & Scenes
// ========================================
async function loadVideoPlan({ freshBuild = false } = {}) {
    try {
        // Try loading from .fvp project file first (unified save with settings)
        // BUT skip .fvp after a fresh build — it has stale data from the previous build
        let plan = null;
        let fvpSettings = null;
        if (!freshBuild && window.electronAPI.loadProjectFile) {
            const projectData = await window.electronAPI.loadProjectFile();
            if (projectData && projectData.videoPlan) {
                plan = projectData.videoPlan;
                fvpSettings = projectData.settings || null;
                state.hasProjectFile = true;
                console.log('✅ Loaded from .fvp project file');
            }
        }

        // Load from video-plan.json (always used after fresh build, fallback otherwise)
        if (!plan) {
            plan = await window.electronAPI.loadVideoPlan();
        }

        if (plan) {
            // Restore editor settings from .fvp if available
            if (fvpSettings) {
                applyProjectSettings(fvpSettings);
            }

            state.videoPlan = plan;
            state._mediaUrlCache = {}; // Clear media URL cache on new plan load
            state._trackActiveEl = { '1': 'a', '2': 'a', '3': 'a' }; // Reset double-buffer state
            state._trackSwapPending = { '1': false, '2': false, '3': false }; // Reset deferred swaps
            // Clear _loadedUrl on all buffer elements
            [elements.videoTrack1, elements.videoTrack2, elements.videoTrack3,
             elements.videoTrack1B, elements.videoTrack2B, elements.videoTrack3B].forEach(v => {
                if (v) { v._loadedUrl = null; v.src = ''; }
            });

            // Check if this is a saved project (scenes already have trackId = edited by user)
            const isSavedProject = plan.scenes.length > 0 && plan.scenes[0].trackId;

            if (isSavedProject) {
                // Restore scenes as-is (user already edited the layout)
                state.scenes = plan.scenes.map(s => ({
                    ...s,
                    trackId: s.trackId || 'video-track-1'
                }));
                state.totalDuration = plan.totalDuration || Math.max(...state.scenes.map(s => s.endTime));
            } else {
                // Fresh build - keep original timestamps, expand scenes to fill gaps
                // Route images to video-track-2, videos stay on video-track-1
                const processedScenes = [];

                for (let i = 0; i < plan.scenes.length; i++) {
                    const scene = plan.scenes[i];
                    const nextScene = plan.scenes[i + 1];

                    // Extend this scene's endTime to fill gap before next scene
                    let endTime = scene.endTime;
                    if (nextScene && nextScene.startTime > scene.endTime) {
                        endTime = nextScene.startTime;
                    }

                    // Assign track based on media type: images → track 2, videos → track 1
                    const trackId = scene.mediaType === 'image' ? 'video-track-2' : 'video-track-1';

                    processedScenes.push({
                        ...scene,
                        originalStartTime: scene.startTime,
                        originalEndTime: scene.endTime,
                        startTime: scene.startTime,
                        endTime: endTime,
                        trackId: trackId
                    });
                }

                state.scenes = processedScenes;
                state.totalDuration = plan.totalDuration || (processedScenes.length > 0 ? processedScenes[processedScenes.length - 1].endTime : 0);
            }

            state.currentTime = 0;

            if (plan.audio) {
                const audioPath = await window.electronAPI.getAudioPath?.(plan.audio);
                if (audioPath) {
                    state.audioPath = audioPath;
                    state.audioFile = { name: plan.audio, path: audioPath };
                    elements.audioName.textContent = plan.audio;
                    elements.audioInfo.classList.remove('hidden');
                    elements.dropZone.style.display = 'none';
                    elements.btnGenerate.disabled = false;
                    await loadAudioFile(audioPath);
                }
            }

            // Enable render button if we have scenes
            if (state.scenes.length > 0) {
                elements.btnRender.disabled = false;
            }

            // Transitions disabled - hard cut only, skip planned transitions

            // Generate SFX for scene change points
            generateSfxClips();

            // Load motion graphics from plan
            // Full-screen types (barChart, donutChart, etc.) go on V3 as scene objects
            const FULLSCREEN_MG_TYPES = new Set(['barChart', 'donutChart', 'rankingList', 'timeline', 'comparisonCard', 'bulletList', 'mapChart', 'articleHighlight']);
            const allMGs = plan.motionGraphics || [];
            state.motionGraphics = allMGs.filter(mg => !FULLSCREEN_MG_TYPES.has(mg.type));
            state.mgStyle = plan.mgStyle || 'clean';

            // Load full-screen MGs onto V3 (from mgScenes or classified from motionGraphics)
            const fullscreenMGs = [
                ...(plan.mgScenes || []),
                ...allMGs.filter(mg => FULLSCREEN_MG_TYPES.has(mg.type))
            ];
            // Deduplicate (in case both mgScenes and motionGraphics have the same MG)
            const seenIds = new Set();
            for (const mg of fullscreenMGs) {
                const key = mg.id || `${mg.type}-${mg.startTime}`;
                if (seenIds.has(key)) continue;
                seenIds.add(key);
                // Strip nested mgData to avoid recursive bloat in saved plans
                const { mgData: _nested, ...mgFlat } = mg;
                // Resolve deeply nested mgData to get the actual core data
                let core = mg;
                while (core.mgData) core = core.mgData;
                const sceneObj = {
                    isMGScene: true,
                    trackId: 'video-track-3',
                    mediaType: 'motion-graphic',
                    startTime: mg.startTime,
                    endTime: mg.endTime || (mg.startTime + mg.duration),
                    duration: Math.round((mg.duration || (mg.endTime - mg.startTime)) * 30),
                    text: mg.text || '',
                    subtext: mg.subtext || '',
                    type: mg.type,
                    position: mg.position || 'center',
                    style: mg.style || state.mgStyle || 'clean',
                    keyword: `MG: ${mg.type}`,
                    mgData: core === mg ? mgFlat : core,
                };
                if (mg.mapStyle) sceneObj.mapStyle = mg.mapStyle;
                // Propagate article image properties for image mode
                if (core.articleImageFile) {
                    sceneObj.articleImageFile = core.articleImageFile;
                    if (sceneObj.mgData) sceneObj.mgData.articleImageFile = core.articleImageFile;
                }
                if (core.highlightBoxes) {
                    sceneObj.highlightBoxes = core.highlightBoxes;
                    if (sceneObj.mgData) sceneObj.mgData.highlightBoxes = core.highlightBoxes;
                }
                // Pre-resolve article image URL for preview
                if (core.articleImageFile && window.electronAPI?.getSceneMediaPath) {
                    const ext = core.articleImageFile.match(/\.\w+$/)?.[0] || '.jpg';
                    window.electronAPI.getSceneMediaPath(0, ext, 'article').then(async (filePath) => {
                        if (filePath && window.electronAPI.getFileUrl) {
                            const url = await window.electronAPI.getFileUrl(filePath);
                            sceneObj._articleImageUrl = url;
                            if (sceneObj.mgData) sceneObj.mgData._articleImageUrl = url;
                        }
                    }).catch(() => {});
                }
                state.scenes.push(sceneObj);
            }
            // Carve out V2 scenes that overlap with full-screen MGs
            // Full-screen MGs ARE the visual — no footage underneath
            if (seenIds.size > 0) {
                const mgRanges = state.scenes
                    .filter(s => s.isMGScene)
                    .map(s => ({ start: s.startTime, end: s.endTime }));
                const carved = [];
                for (const scene of state.scenes) {
                    if (scene.isMGScene) {
                        carved.push(scene);
                        continue;
                    }
                    let parts = [{ start: scene.startTime, end: scene.endTime }];
                    for (const range of mgRanges) {
                        const next = [];
                        for (const p of parts) {
                            if (range.start >= p.end || range.end <= p.start) {
                                next.push(p);
                            } else if (range.start <= p.start && range.end >= p.end) {
                                // fully covered — remove
                            } else if (range.start > p.start && range.end < p.end) {
                                next.push({ start: p.start, end: range.start });
                                next.push({ start: range.end, end: p.end });
                            } else if (range.start <= p.start) {
                                next.push({ start: range.end, end: p.end });
                            } else {
                                next.push({ start: p.start, end: range.start });
                            }
                        }
                        parts = next;
                    }
                    for (const p of parts) {
                        if (p.end - p.start < 0.3) continue;
                        const trimmed = { ...scene };
                        const offset = p.start - scene.startTime;
                        trimmed.startTime = p.start;
                        trimmed.endTime = p.end;
                        if (offset > 0) {
                            trimmed.mediaOffset = (scene.mediaOffset || 0) + offset;
                        }
                        carved.push(trimmed);
                    }
                }
                state.scenes = carved;
                console.log(`Loaded ${seenIds.size} full-screen MGs onto V3 (carved gaps in V2)`);
            }

            renderScenes();
            renderTimeline();

            // Pre-cache ALL scene media URLs upfront so playback never waits for IPC
            console.log(`[PreCache] Pre-caching media URLs for ${state.scenes.length} scenes...`);
            const cachePromises = state.scenes
                .filter(s => !s.isMGScene)
                .map((scene, i) => {
                    const idx = scene.index !== undefined ? scene.index : i;
                    return getCachedMediaUrl(idx, scene.mediaExtension).catch(() => null);
                });
            await Promise.all(cachePromises);
            console.log(`[PreCache] Done. Cached ${Object.keys(state._mediaUrlCache).length} URLs`);

            // Load plan into WebGL2 compositor if it's initialized
            if (state.compositor) {
                loadPlanIntoCompositor().catch(e => console.warn('[Compositor] Plan load deferred:', e.message));
            }

            // Pre-buffer the SECOND video scene into the buffer element for instant first transition
            preloadUpcomingScenes(0, true);
        }
    } catch (error) {
        console.error('Failed to load video plan:', error);
    }
}

// ========================================
// SFX Auto-Placement System
// ========================================
const SFX_MAP = {
    // === Smooth / Cinematic ===
    fade:           { file: 'sfx-fade.mp3',          duration: 0.5 },
    dissolve:       { file: 'sfx-dissolve.mp3',      duration: 0.5 },
    crossfade:      { file: 'sfx-fade.mp3',          duration: 0.5 },
    blur:           { file: 'sfx-blur.mp3',          duration: 0.5 },
    crossBlur:      { file: 'sfx-blur.mp3',          duration: 0.5 },
    luma:           { file: 'sfx-wipe.mp3',          duration: 0.3 },
    ripple:         { file: 'sfx-ripple.mp3',        duration: 0.7 },
    reveal:         { file: 'sfx-ink.mp3',           duration: 0.6 },
    morph:          { file: 'sfx-blur.mp3',          duration: 0.5 },
    dreamFade:      { file: 'sfx-fade.mp3',          duration: 0.5 },
    filmBurn:       { file: 'sfx-filmburn.mp3',      duration: 0.6 },
    // === Energetic / Dynamic ===
    slide:          { file: 'sfx-slide.mp3',         duration: 0.4 },
    wipe:           { file: 'sfx-wipe.mp3',          duration: 0.3 },
    zoom:           { file: 'sfx-zoom.mp3',          duration: 0.5 },
    push:           { file: 'sfx-slide.mp3',         duration: 0.4 },
    swipe:          { file: 'sfx-wipe.mp3',          duration: 0.3 },
    whip:           { file: 'sfx-whip.mp3',          duration: 0.3 },
    bounce:         { file: 'sfx-bounce.mp3',        duration: 0.4 },
    splitWipe:      { file: 'sfx-wipe.mp3',          duration: 0.3 },
    shutterSlice:   { file: 'sfx-shutter.mp3',       duration: 0.3 },
    zoomBlur:       { file: 'sfx-zoom.mp3',          duration: 0.5 },
    // === Dramatic / Film ===
    flash:          { file: 'sfx-flash.mp3',         duration: 0.3 },
    cameraFlash:    { file: 'sfx-camera-flash.mp3',  duration: 0.3 },
    flare:          { file: 'sfx-flare.mp3',         duration: 0.6 },
    lightLeak:      { file: 'sfx-flare.mp3',         duration: 0.6 },
    vignetteBlink:  { file: 'sfx-camera-flash.mp3',  duration: 0.3 },
    shadowWipe:     { file: 'sfx-wipe.mp3',          duration: 0.3 },
    filmGrain:      { file: 'sfx-filmburn.mp3',      duration: 0.6 },
    ink:            { file: 'sfx-ink.mp3',           duration: 0.6 },
    directionalBlur:{ file: 'sfx-blur.mp3',          duration: 0.5 },
    colorFade:      { file: 'sfx-fade.mp3',          duration: 0.5 },
    spin:           { file: 'sfx-spin.mp3',          duration: 0.6 },
    prismShift:     { file: 'sfx-prism.mp3',         duration: 0.5 },
    // === Glitch / Tech ===
    glitch:         { file: 'sfx-glitch.mp3',        duration: 0.4 },
    pixelate:       { file: 'sfx-glitch.mp3',        duration: 0.4 },
    mosaic:         { file: 'sfx-glitch.mp3',        duration: 0.4 },
    dataMosh:       { file: 'sfx-glitch.mp3',        duration: 0.4 },
    scanline:       { file: 'sfx-static.mp3',        duration: 0.5 },
    rgbSplit:       { file: 'sfx-glitch.mp3',        duration: 0.4 },
    static:         { file: 'sfx-static.mp3',        duration: 0.5 },
};

function generateSfxClips() {
    if (!state.sfxEnabled) {
        state.sfxClips = [];
        return;
    }

    const clips = [];

    // Group scenes by track — only video tracks get transition SFX
    const trackGroups = {};
    state.scenes.forEach((scene, idx) => {
        if (scene.isMGScene) return; // Skip MG scenes
        const trackId = scene.trackId || 'video-track-1';
        if (!trackId.startsWith('video-track-')) return; // Only video tracks
        if (!trackGroups[trackId]) trackGroups[trackId] = [];
        trackGroups[trackId].push({ scene, idx });
    });

    // For each track, find adjacent scene boundaries (transition points)
    for (const trackId of Object.keys(trackGroups)) {
        const trackScenes = trackGroups[trackId].sort((a, b) => a.scene.startTime - b.scene.startTime);

        for (let i = 1; i < trackScenes.length; i++) {
            const prev = trackScenes[i - 1];
            const curr = trackScenes[i];

            // Check if scenes are adjacent (gap < 0.1s = transition point)
            const gap = curr.scene.startTime - prev.scene.endTime;
            if (Math.abs(gap) > 0.1) continue;

            // Resolve transition type (per-scene or global, deterministic random)
            let transType = curr.scene.transitionType || state.transition.style;
            if (transType === 'random' || transType === 'auto') {
                const seed = curr.idx * 7 + 3;
                transType = state.transition.types[seed % state.transition.types.length];
            }

            // No SFX for cuts
            if (transType === 'cut') continue;

            const sfxInfo = SFX_MAP[transType] || SFX_MAP['fade'];

            // Start SFX slightly before the transition point (50ms pre-roll)
            const preRoll = 0.05;
            const startTime = Math.max(0, curr.scene.startTime - preRoll);

            clips.push({
                id: `sfx-${clips.length}`,
                transitionType: transType,
                sceneIndex: curr.idx,
                startTime: startTime,
                duration: sfxInfo.duration,
                volume: state.sfxVolume,
                file: sfxInfo.file
            });
        }
    }

    state.sfxClips = clips;
}

function renderScenes() {
    // Filter out overlay and MG scenes from the scene list
    const displayScenes = state.scenes.filter(s => !s.isMGScene);
    if (displayScenes.length === 0) { elements.sceneList.innerHTML = '<p class="empty-state">No scenes yet</p>'; return; }
    elements.sceneList.innerHTML = displayScenes.map((scene) => {
        const i = state.scenes.indexOf(scene);
        return `<div class="scene-card" data-index="${i}">
            <div class="scene-number">Scene ${i + 1}</div>
            <div class="scene-text">${scene.text}</div>
            <div class="scene-keyword">🔍 ${scene.keyword}</div>
        </div>`;
    }).join('');
    document.querySelectorAll('.scene-card').forEach(card => {
        card.addEventListener('click', () => jumpToScene(parseInt(card.dataset.index)));
    });
}

// ========================================
// Timeline Rendering - COMPLETELY FIXED
// ========================================
function renderTimeline() {
    const container = elements.timelineContainer;
    const duration = Math.max(state.totalDuration, 60);
    const totalWidth = (duration * state.timeline.zoom) + TRACK_HEADER_WIDTH + 500;

    // Reset cached DOM refs — innerHTML destroys old elements
    _cachedPlayhead = null;
    _cachedTimelineScroll = null;
    _cachedTimelineTime = null;

    container.innerHTML = `
        <div class="timeline-header">
            <div class="timeline-header-left">
                <span>Timeline</span>
                <button id="snap-toggle" class="snap-toggle ${state.snapEnabled ? 'active' : ''}" title="Toggle Snap to Clips">
                    <span class="snap-icon">🧲</span>
                    <span class="snap-label">Snap</span>
                </button>
            </div>
            <div class="timeline-info">
                <div class="zoom-control">
                    <span class="zoom-label">🔍</span>
                    <button id="zoom-fit-btn" class="zoom-fit-btn" title="Fit timeline to view (Shift+F)">Fit</button>
                    <input type="range" id="zoom-slider" class="zoom-slider" min="0" max="1000" value="${zoomToSlider(state.timeline.zoom)}" step="1">
                    <span id="timeline-zoom">${formatZoomLabel(state.timeline.zoom)}</span>
                </div>
                <span class="divider">|</span>
                <span id="timeline-time">${formatTime(state.currentTime)} / ${formatTime(state.totalDuration)}</span>
            </div>
        </div>
        <div class="timeline-body">
            <div class="timeline-ruler" id="timeline-ruler" style="width:${totalWidth}px; margin-left:${TRACK_HEADER_WIDTH}px"></div>
            <div class="timeline-scroll" id="timeline-scroll">
                <div class="timeline-content" id="timeline-content" style="width:${totalWidth}px"></div>
            </div>
            <div class="playhead" id="playhead"><div class="playhead-head"></div><div class="playhead-line"></div></div>
        </div>
    `;

    renderRuler(duration);
    renderTracks();
    updatePlayhead();

    const scroll = document.getElementById('timeline-scroll');
    scroll.addEventListener('scroll', () => { state.timeline.scrollX = scroll.scrollLeft; updatePlayhead(); });
    scroll.addEventListener('wheel', (e) => {
        if (e.ctrlKey) { e.preventDefault(); changeZoom(e.deltaY < 0 ? 10 : -10); }
        else if (e.shiftKey || e.altKey) { e.preventDefault(); scroll.scrollLeft += e.deltaY; }
    });

    // Setup zoom slider (logarithmic scale)
    const zoomSlider = document.getElementById('zoom-slider');
    if (zoomSlider) {
        zoomSlider.addEventListener('input', (e) => {
            const newZoom = sliderToZoom(parseFloat(e.target.value));
            applyZoom(newZoom);
        });
    }

    // Fit button - zoom to fit entire timeline in view
    const fitBtn = document.getElementById('zoom-fit-btn');
    if (fitBtn) {
        fitBtn.addEventListener('click', zoomToFit);
    }

    // Setup snap toggle
    const snapToggle = document.getElementById('snap-toggle');
    if (snapToggle) {
        snapToggle.addEventListener('click', () => {
            state.snapEnabled = !state.snapEnabled;
            snapToggle.classList.toggle('active', state.snapEnabled);
            showToast(`Snap ${state.snapEnabled ? 'enabled' : 'disabled'}`, 'info');
        });
    }

    setupPlayhead();
    setupRulerClick();
}

function renderRuler(duration) {
    const ruler = document.getElementById('timeline-ruler');
    const zoom = state.timeline.zoom;

    // Adaptive step: ensure ticks are at least ~50px apart, labels ~100px apart
    let step;
    if (zoom >= 50) step = 1;
    else if (zoom >= 20) step = 5;
    else if (zoom >= 5) step = 10;
    else if (zoom >= 2) step = 30;     // 30s steps
    else if (zoom >= 1) step = 60;     // 1min steps
    else if (zoom >= 0.5) step = 120;  // 2min steps
    else step = 300;                   // 5min steps

    const labelEvery = step <= 5 ? step * 2 : step;
    const majorEvery = step <= 10 ? step * 5 : step * 2;

    let html = '';
    for (let t = 0; t <= duration + step; t += step) {
        const left = t * zoom;
        const isMajor = t % majorEvery === 0;
        html += `<div class="ruler-tick ${isMajor ? 'major' : ''}" style="left:${left}px"></div>`;
        if (t % labelEvery === 0) {
            html += `<div class="ruler-label" style="left:${left}px">${formatTime(t)}</div>`;
        }
    }
    ruler.innerHTML = html;
}

function renderTracks() {
    const content = document.getElementById('timeline-content');
    let html = '';
    const svgMuted = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
    const svgUnmuted = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
    state.timeline.tracks.forEach((track, trackIndex) => {
        const isMuted = state.mutedTracks[track.id] || false;
        const muteIcon = isMuted ? svgMuted : svgUnmuted;
        const muteClass = isMuted ? 'track-muted' : '';
        let trackHeight = state.timeline.trackHeights[track.id] || 36;
        const mgTestBtn = track.id === 'mg-track' ? `<button class="mg-test-btn" data-action="inject-test-mg" title="Inject 6 test MGs">+</button>` : '';
        html += `<div class="timeline-row ${muteClass}" data-track="${track.id}" style="height:${trackHeight}px">
            <div class="track-label"><span class="track-label-text">${track.label}</span>${mgTestBtn}<button class="track-mute-btn ${isMuted ? 'muted' : ''}" data-track-mute="${track.id}" title="${isMuted ? 'Unmute' : 'Mute'} track">${muteIcon}</button></div>
            <div class="track-content ${track.type}-track" data-track="${track.id}">`;

        // Audio clip on its current track - use actual audio duration, not totalDuration
        if (track.id === (state.audioClipTrack || 'audio-track') && state.audioFile && state.totalDuration > 0) {
            const audioLeft = (state.audioClipOffset || 0) * state.timeline.zoom;
            const actualAudioDur = (elements.previewAudio && isFinite(elements.previewAudio.duration)) ? elements.previewAudio.duration : state.totalDuration;
            const w = actualAudioDur * state.timeline.zoom;
            // Generate pseudo-waveform bars
            let waveHtml = '<div class="audio-waveform-bars">';
            const barCount = Math.min(Math.floor(w / 3), 500);
            for (let b = 0; b < barCount; b++) { waveHtml += `<div class="waveform-bar" style="height:${20 + Math.random() * 60}%"></div>`; }
            waveHtml += '</div>';
            html += `<div class="timeline-clip audio-clip" data-audio-clip="voice" data-track="audio-track" style="left:${audioLeft}px;width:${w}px" title="${state.audioFile.name}">
                ${waveHtml}
                <span class="clip-label">${state.audioFile.name}</span>
                <button class="audio-clip-delete" title="Remove audio">✕</button>
            </div>`;
        }

        // Motion Graphics clips on mg-track (per-type colors)
        if (track.id === 'mg-track' && state.motionGraphics.length > 0) {
            const mgMeta = {
                headline:       { icon: 'H',  colorClass: 'mg-headline' },
                lowerThird:     { icon: 'L3', colorClass: 'mg-lowerthird' },
                statCounter:    { icon: '#',  colorClass: 'mg-stat' },
                callout:        { icon: '"',  colorClass: 'mg-callout' },
                bulletList:     { icon: '::', colorClass: 'mg-bullets' },
                focusWord:      { icon: 'F',  colorClass: 'mg-focusword' },
                progressBar:    { icon: '%',  colorClass: 'mg-progressbar' },
                barChart:       { icon: 'BC', colorClass: 'mg-barchart' },
                donutChart:     { icon: 'DC', colorClass: 'mg-donutchart' },
                comparisonCard: { icon: 'VS', colorClass: 'mg-comparison' },
                timeline:       { icon: 'TL', colorClass: 'mg-timeline-clip' },
                rankingList:    { icon: 'RK', colorClass: 'mg-ranking' },
                kineticText:    { icon: 'KT', colorClass: 'mg-kinetic' },
            };
            state.motionGraphics.forEach((mg, i) => {
                const left = mg.startTime * state.timeline.zoom;
                const w = mg.duration * state.timeline.zoom;
                const meta = mgMeta[mg.type] || { icon: '?', colorClass: '' };
                const isDisabled = mg.disabled === true;
                const isSelected = state.selectedMgIndex === i;
                const eyeIcon = isDisabled ? '👁️‍🗨️' : '👁️';
                // Compact marker style: max 60px wide to prevent oversized blocks
                const clampedW = Math.min(Math.max(w, 20), 60);
                html += `<div class="timeline-clip mg-clip ${meta.colorClass} ${isDisabled ? 'clip-disabled' : ''} ${isSelected ? 'selected' : ''}" data-mg-index="${i}"
                    style="left:${left}px;width:${clampedW}px"
                    title="${mg.type}: ${mg.text} (${mg.duration.toFixed(1)}s)${isDisabled ? ' [OFF]' : ''}">
                    <span class="clip-label">${meta.icon}</span>
                    <button class="clip-toggle-btn" data-toggle-mg="${i}" title="${isDisabled ? 'Enable' : 'Disable'} graphic">${eyeIcon}</button>
                </div>`;
            });
        }

        // SFX clips on sfx-track
        if (track.id === 'sfx-track' && state.sfxClips.length > 0) {
            state.sfxClips.forEach((sfx, i) => {
                const left = sfx.startTime * state.timeline.zoom;
                const w = sfx.duration * state.timeline.zoom;
                const icon = state.transition.metadata[sfx.transitionType]?.icon || '🔊';
                html += `<div class="timeline-clip sfx-clip" data-sfx-index="${i}"
                    style="left:${left}px;width:${Math.max(w, 8)}px"
                    title="SFX: ${sfx.transitionType} (${sfx.duration.toFixed(2)}s)">
                    <span class="clip-label">${icon}</span>
                </div>`;
            });
        }

        // Scene clips on this track
        const trackScenes = state.scenes.filter(s => (s.trackId || 'video-track-1') === track.id);
        let overlayLaneIndex = 0; // Track overlay lane for vertical stacking
        trackScenes.forEach((scene, i) => {
            const idx = state.scenes.indexOf(scene);
            const left = scene.startTime * state.timeline.zoom;
            const width = (scene.endTime - scene.startTime) * state.timeline.zoom;

            // Full-screen MG scene on V3
            if (scene.isMGScene) {
                const mgMeta = {
                    barChart:       { name: 'Bar Chart',       colorClass: 'mg-barchart' },
                    donutChart:     { name: 'Donut Chart',     colorClass: 'mg-donutchart' },
                    comparisonCard: { name: 'Comparison',      colorClass: 'mg-comparison' },
                    timeline:       { name: 'Timeline',        colorClass: 'mg-timeline-clip' },
                    rankingList:    { name: 'Ranking',         colorClass: 'mg-ranking' },
                    bulletList:     { name: 'Bullet List',     colorClass: 'mg-bullets' },
                    mapChart:       { name: 'Map',             colorClass: 'mg-mapchart' },
                    articleHighlight: { name: 'Article',       colorClass: 'mg-article' },
                };
                const meta = mgMeta[scene.type] || { name: scene.type || 'MG', colorClass: '' };
                const clipName = scene.text ? `${meta.name}: ${scene.text}` : meta.name;
                const isDisabled = scene.disabled === true;
                const eyeIcon = isDisabled ? '👁️‍🗨️' : '👁️';
                html += `<div class="timeline-clip clip-mg-scene ${meta.colorClass} ${isDisabled ? 'clip-disabled' : ''} ${state.selectedClipIndices.includes(idx) ? 'selected' : ''}"
                    data-index="${idx}" style="left:${left}px;width:${width}px"
                    title="${clipName} (${(scene.endTime - scene.startTime).toFixed(1)}s)${isDisabled ? ' [OFF]' : ''}">
                    <div class="clip-trim-handle clip-trim-handle-left" data-index="${idx}" data-edge="left"></div>
                    <span class="clip-label">${clipName}</span>
                    <button class="clip-toggle-btn" data-toggle-idx="${idx}" title="${isDisabled ? 'Enable' : 'Disable'} graphic">${eyeIcon}</button>
                    <div class="clip-trim-handle clip-trim-handle-right" data-index="${idx}" data-edge="right"></div>
                </div>`;
                return;
            }

            const mediaClass = scene.mediaType === 'image' ? 'clip-image' : 'clip-video';
            const isDisabled = scene.disabled === true;
            const eyeIcon = isDisabled ? '👁️‍🗨️' : '👁️';
            // Clip separator line for adjacent clips
            if (i > 0) {
                const prevScene = trackScenes[i - 1];
                if (Math.abs(prevScene.endTime - scene.startTime) < 0.05) {
                    html += `<div class="clip-separator" style="left:${left}px"></div>`;
                }
            }

            html += `<div class="timeline-clip ${mediaClass} ${isDisabled ? 'clip-disabled' : ''} ${idx === state.currentSceneIndex ? 'active' : ''} ${state.selectedClipIndices.includes(idx) ? 'selected' : ''}"
                data-index="${idx}" style="left:${left}px;width:${width}px" title="${scene.text}${isDisabled ? ' [OFF]' : ''}">
                <div class="clip-trim-handle clip-trim-handle-left" data-index="${idx}" data-edge="left"></div>
                <span class="clip-label">${scene.text.substring(0, 30)}${scene.text.length > 30 ? '...' : ''}</span>
                <button class="clip-toggle-btn" data-toggle-idx="${idx}" title="${isDisabled ? 'Enable' : 'Disable'} clip">${eyeIcon}</button>
                <div class="clip-trim-handle clip-trim-handle-right" data-index="${idx}" data-edge="right"></div>
            </div>`;
        });

        html += `</div></div>`;
        // Add resize handle between tracks (except after last track)
        if (trackIndex < state.timeline.tracks.length - 1) {
            html += `<div class="track-resize-handle" data-resize-track="${track.id}"></div>`;
        }
    });
    content.innerHTML = html;

    // Clip events
    document.querySelectorAll('.timeline-clip[data-index]').forEach(clip => {
        clip.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('clip-toggle-btn')) return;
            startDragClip(e, clip);
        });
        clip.addEventListener('click', (e) => {
            if (e.target.classList.contains('clip-toggle-btn')) return;
            e.stopPropagation();
            const idx = parseInt(clip.dataset.index);
            selectClip(idx, e.ctrlKey || e.metaKey);
            if (!e.ctrlKey && !e.metaKey) jumpToScene(idx);
        });
    });

    // Trim handle events (must come before general clip drag)
    document.querySelectorAll('.clip-trim-handle').forEach(handle => {
        handle.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            startTrimClip(e, handle);
        });
    });

    // Audio clip drag (horizontal only, locked to audio tracks)
    document.querySelectorAll('.timeline-clip[data-audio-clip]').forEach(audioClip => {
        audioClip.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('audio-clip-delete')) return; // Don't drag when clicking delete
            startDragAudioClip(e, audioClip);
        });
    });

    // Audio clip delete button
    document.querySelectorAll('.audio-clip-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm('Remove audio from project?')) {
                removeAudio();
                renderTimeline();
                showToast('Audio removed', 'info');
            }
        });
    });

    // Click empty track to seek (only if not marquee selecting)
    document.querySelectorAll('.track-content').forEach(tc => {
        tc.addEventListener('click', (e) => {
            if (e.target.classList.contains('track-content') && !state._marqueeUsed) {
                const rect = tc.getBoundingClientRect();
                const time = (e.clientX - rect.left + document.getElementById('timeline-scroll').scrollLeft) / state.timeline.zoom;
                seekToTime(Math.max(0, time));
            }
            state._marqueeUsed = false;
        });
    });

    // Track mute buttons
    document.querySelectorAll('.track-mute-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const trackId = btn.dataset.trackMute;
            state.mutedTracks[trackId] = !state.mutedTracks[trackId];
            const isMuted = state.mutedTracks[trackId];
            btn.textContent = isMuted ? '🔇' : '🔊';
            btn.classList.toggle('muted', isMuted);
            btn.title = (isMuted ? 'Unmute' : 'Mute') + ' track';
            btn.closest('.timeline-row').classList.toggle('track-muted', isMuted);
            applyTrackVolumes();
            // Sync MG track mute with MG enable flag
            if (trackId === 'mg-track') {
                state.mgEnabled = !isMuted;
                if (elements.mgEnabled) elements.mgEnabled.checked = !isMuted;
                saveSettings();
            }
        });
    });

    // MG test inject button
    document.querySelectorAll('[data-action="inject-test-mg"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            injectTestMotionGraphics();
        });
    });

    // Per-clip toggle buttons (MG clips)
    document.querySelectorAll('.clip-toggle-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Overlay clip toggle
            if (btn.dataset.toggleIdx !== undefined) {
                const idx = parseInt(btn.dataset.toggleIdx);
                const scene = state.scenes[idx];
                if (scene) {
                    scene.disabled = !scene.disabled;
                    renderTracks();
                }
            }
            // MG clip toggle
            if (btn.dataset.toggleMg !== undefined) {
                const mgIdx = parseInt(btn.dataset.toggleMg);
                const mg = state.motionGraphics[mgIdx];
                if (mg) {
                    mg.disabled = !mg.disabled;
                    renderTracks();
                }
            }
        });
    });

    // MG clip click to select and show properties
    document.querySelectorAll('.mg-clip').forEach(clip => {
        clip.addEventListener('click', (e) => {
            if (e.target.classList.contains('clip-toggle-btn')) return; // Don't select when toggling
            e.stopPropagation();
            const mgIdx = parseInt(clip.dataset.mgIndex);
            if (isNaN(mgIdx)) return;
            // Deselect any regular/overlay clip
            state.selectedClipIndex = -1;
            state.selectedClipIndices = [];
            clearSceneTransform();
            document.querySelectorAll('.timeline-clip').forEach(c => c.classList.remove('selected'));
            // Select this MG
            state.selectedMgIndex = mgIdx;
            document.querySelectorAll('.mg-clip').forEach(c => c.classList.remove('selected'));
            clip.classList.add('selected');
            updateClipProperties();
        });
    });

    // Marquee drag-to-select on timeline
    setupMarqueeSelect();

    // Track resize handles
    setupTrackResize();

    // Async load thumbnails for video/image clips
    loadClipThumbnails();
}

// ========================================
// Track Resize
// ========================================
function setupTrackResize() {
    document.querySelectorAll('.track-resize-handle').forEach(handle => {
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const trackId = handle.dataset.resizeTrack;
            const startY = e.clientY;
            const startHeight = state.timeline.trackHeights[trackId] || 36;
            handle.classList.add('active');
            document.body.style.cursor = 'ns-resize';
            document.body.style.userSelect = 'none';

            const onMove = (me) => {
                const delta = me.clientY - startY;
                const min = state.timeline.trackMinHeights[trackId] || 18;
                const max = state.timeline.trackMaxHeights[trackId] || 120;
                const newHeight = Math.max(min, Math.min(max, startHeight + delta));
                state.timeline.trackHeights[trackId] = newHeight;
                const row = document.querySelector(`.timeline-row[data-track="${trackId}"]`);
                if (row) row.style.height = `${newHeight}px`;
            };

            const onUp = () => {
                handle.classList.remove('active');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    });
}

// ========================================
// Clip Thumbnails
// ========================================
const thumbnailCache = {};

async function loadClipThumbnails() {
    if (!window.electronAPI?.getSceneMediaPath) return;
    document.querySelectorAll('.timeline-clip[data-index]').forEach(async (clipEl) => {
        const idx = parseInt(clipEl.dataset.index);
        const scene = state.scenes[idx];
        if (!scene) return;

        // Check cache first
        if (thumbnailCache[idx] !== undefined) {
            if (thumbnailCache[idx] && clipEl.isConnected) {
                clipEl.style.backgroundImage = `url("${thumbnailCache[idx]}")`;
                clipEl.classList.add('has-thumbnail');
            }
            return;
        }

        try {
            // Try frame-{index}.jpg first (from vision analysis)
            const originalIdx = scene.index !== undefined ? scene.index : idx;
            let framePath = await window.electronAPI.getSceneMediaPath(originalIdx, '.jpg', 'frame');
            if (framePath) {
                const url = await window.electronAPI.getFileUrl(framePath);
                thumbnailCache[idx] = url;
                if (url && clipEl.isConnected) {
                    clipEl.style.backgroundImage = `url("${url}")`;
                    clipEl.classList.add('has-thumbnail');
                }
                return;
            }
            // Fallback: if scene is an image, use it directly
            if (scene.mediaType === 'image') {
                const imgPath = await window.electronAPI.getSceneMediaPath(originalIdx, scene.mediaExtension);
                if (imgPath) {
                    const url = await window.electronAPI.getFileUrl(imgPath);
                    thumbnailCache[idx] = url;
                    if (url && clipEl.isConnected) {
                        clipEl.style.backgroundImage = `url("${url}")`;
                        clipEl.classList.add('has-thumbnail');
                    }
                    return;
                }
            }
            thumbnailCache[idx] = null;
        } catch (e) {
            thumbnailCache[idx] = null;
        }
    });
}

// ========================================
// Marquee Drag-to-Select (like Premiere Pro)
// ========================================
function setupMarqueeSelect() {
    const scroll = document.getElementById('timeline-scroll');
    if (!scroll) return;

    let marquee = document.getElementById('timeline-marquee');
    if (!marquee) {
        marquee = document.createElement('div');
        marquee.id = 'timeline-marquee';
        marquee.className = 'timeline-marquee';
        scroll.style.position = 'relative';
        scroll.appendChild(marquee);
    }

    let isMarquee = false;
    let startX = 0, startY = 0;

    scroll.addEventListener('mousedown', (e) => {
        // Only start marquee on left-click on empty area (not on a clip or handle)
        if (e.button !== 0) return;
        if (e.target.closest('.timeline-clip') || e.target.closest('.clip-trim-handle') || e.target.closest('.playhead') || e.target.closest('.transition-icon')) return;

        isMarquee = true;
        const scrollRect = scroll.getBoundingClientRect();
        startX = e.clientX - scrollRect.left + scroll.scrollLeft;
        startY = e.clientY - scrollRect.top + scroll.scrollTop;

        marquee.style.display = 'none';

        // Deselect if not holding Ctrl
        if (!e.ctrlKey && !e.metaKey) {
            deselectClip();
        }
    });

    document.addEventListener('mousemove', (e) => {
        if (!isMarquee) return;

        const scrollRect = scroll.getBoundingClientRect();
        const curX = e.clientX - scrollRect.left + scroll.scrollLeft;
        const curY = e.clientY - scrollRect.top + scroll.scrollTop;

        const left = Math.min(startX, curX);
        const top = Math.min(startY, curY);
        const width = Math.abs(curX - startX);
        const height = Math.abs(curY - startY);

        // Only show marquee if dragged more than 5px (avoid accidental selections)
        if (width > 5 || height > 5) {
            marquee.style.display = 'block';
            marquee.style.left = left + 'px';
            marquee.style.top = top + 'px';
            marquee.style.width = width + 'px';
            marquee.style.height = height + 'px';

            // Live highlight: check intersection with clips
            highlightClipsInMarquee(left, top, width, height, e.ctrlKey || e.metaKey);
        }
    });

    document.addEventListener('mouseup', (e) => {
        if (!isMarquee) return;
        isMarquee = false;

        if (marquee.style.display === 'block') {
            state._marqueeUsed = true; // Prevent seek on this click
            marquee.style.display = 'none';
        }
    });
}

function highlightClipsInMarquee(mLeft, mTop, mWidth, mHeight, addToExisting) {
    const scroll = document.getElementById('timeline-scroll');
    if (!scroll) return;

    const scrollRect = scroll.getBoundingClientRect();
    const mRight = mLeft + mWidth;
    const mBottom = mTop + mHeight;

    const newSelection = addToExisting ? [...state.selectedClipIndices] : [];

    document.querySelectorAll('.timeline-clip[data-index]').forEach(clip => {
        const idx = parseInt(clip.dataset.index);
        // Use getBoundingClientRect relative to scroll container for accuracy
        const clipRect = clip.getBoundingClientRect();
        const clipLeft = clipRect.left - scrollRect.left + scroll.scrollLeft;
        const clipTop = clipRect.top - scrollRect.top + scroll.scrollTop;
        const clipRight = clipLeft + clipRect.width;
        const clipBottom = clipTop + clipRect.height;

        // Check overlap
        const overlaps = !(clipRight < mLeft || clipLeft > mRight || clipBottom < mTop || clipTop > mBottom);

        if (overlaps && !newSelection.includes(idx)) {
            newSelection.push(idx);
        }
    });

    // Update selection visually
    state.selectedClipIndices = newSelection;
    state.selectedClipIndex = newSelection.length > 0 ? newSelection[newSelection.length - 1] : -1;

    document.querySelectorAll('.timeline-clip[data-index]').forEach(c => {
        const idx = parseInt(c.dataset.index);
        c.classList.toggle('selected', newSelection.includes(idx));
    });
}

// Logarithmic zoom slider: maps 0-1000 slider range to 0.5-200 px/s zoom
// This makes low zoom values (for long videos) easy to fine-tune
function sliderToZoom(sliderVal) {
    const minLog = Math.log(state.timeline.minZoom);
    const maxLog = Math.log(state.timeline.maxZoom);
    return Math.exp(minLog + (sliderVal / 1000) * (maxLog - minLog));
}

function zoomToSlider(zoom) {
    const minLog = Math.log(state.timeline.minZoom);
    const maxLog = Math.log(state.timeline.maxZoom);
    return Math.round(((Math.log(zoom) - minLog) / (maxLog - minLog)) * 1000);
}

function formatZoomLabel(zoom) {
    if (zoom >= 10) return `${Math.round(zoom)}px/s`;
    if (zoom >= 1) return `${zoom.toFixed(1)}px/s`;
    return `${zoom.toFixed(2)}px/s`;
}

function changeZoom(delta) {
    // Scale delta proportionally to current zoom for smooth feel
    const scaledDelta = delta * Math.max(0.1, state.timeline.zoom * 0.15);
    applyZoom(state.timeline.zoom + scaledDelta, true);
}

function zoomToFit() {
    const scroll = document.getElementById('timeline-scroll');
    if (!scroll || state.totalDuration <= 0) return;
    // Calculate zoom so entire duration fits in visible area (with some padding)
    const availableWidth = scroll.clientWidth - 40; // small padding
    const fitZoom = availableWidth / state.totalDuration;
    applyZoom(Math.max(state.timeline.minZoom, Math.min(state.timeline.maxZoom, fitZoom)), true);
    // Scroll to start
    requestAnimationFrame(() => { scroll.scrollLeft = 0; });
}

function applyZoom(newZoom, fullRerender = false) {
    const scroll = document.getElementById('timeline-scroll');
    const oldZoom = state.timeline.zoom;
    newZoom = Math.max(state.timeline.minZoom, Math.min(state.timeline.maxZoom, newZoom));
    if (newZoom === oldZoom) return;

    // Keep playhead centered in viewport after zoom
    const playheadRatio = scroll ? ((state.currentTime * oldZoom - scroll.scrollLeft) / scroll.clientWidth) : 0.5;

    state.timeline.zoom = newZoom;

    if (fullRerender) {
        // Full re-render (from Ctrl+scroll or other non-slider sources)
        renderTimeline();
    } else {
        // Lightweight update - don't rebuild header (preserves slider drag state)
        const duration = Math.max(state.totalDuration, 60);
        const totalWidth = (duration * newZoom) + TRACK_HEADER_WIDTH + 500;

        const ruler = document.getElementById('timeline-ruler');
        const content = document.getElementById('timeline-content');
        if (ruler) { ruler.style.width = `${totalWidth}px`; renderRuler(duration); }
        if (content) { content.style.width = `${totalWidth}px`; }
        renderTracks();
        updatePlayhead();

        // Update zoom label and slider position
        const zoomLabel = document.getElementById('timeline-zoom');
        if (zoomLabel) zoomLabel.textContent = formatZoomLabel(newZoom);
        const slider = document.getElementById('zoom-slider');
        if (slider) slider.value = zoomToSlider(newZoom);
    }

    // Restore scroll so playhead stays at same viewport position
    const newScroll = document.getElementById('timeline-scroll');
    if (newScroll) {
        const newPlayheadAbsX = state.currentTime * newZoom;
        newScroll.scrollLeft = newPlayheadAbsX - playheadRatio * newScroll.clientWidth;
        state.timeline.scrollX = newScroll.scrollLeft;
        updatePlayhead();
    }
}

// ========================================
// PLAYHEAD - FIXED
// ========================================
function setupPlayhead() {
    const playhead = document.getElementById('playhead');
    playhead.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        state.timeline.isDraggingPlayhead = true;
        playhead.classList.add('dragging');
        document.body.style.cursor = 'ew-resize';

        const onMove = (me) => {
            const scroll = document.getElementById('timeline-scroll');
            const body = document.querySelector('.timeline-body');
            const rect = body.getBoundingClientRect();
            const x = me.clientX - rect.left - TRACK_HEADER_WIDTH + scroll.scrollLeft;
            const time = Math.max(0, x / state.timeline.zoom);
            state.currentTime = time;
            updatePlayhead();
            updateTimeDisplay();
            scrubMedia(time);
        };

        const onUp = () => {
            state.timeline.isDraggingPlayhead = false;
            playhead.classList.remove('dragging');
            document.body.style.cursor = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            seekToTime(state.currentTime);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

function setupRulerClick() {
    document.getElementById('timeline-ruler')?.addEventListener('click', (e) => {
        const rect = e.target.closest('.timeline-ruler').getBoundingClientRect();
        const scroll = document.getElementById('timeline-scroll');
        const x = e.clientX - rect.left + scroll.scrollLeft;
        seekToTime(Math.max(0, x / state.timeline.zoom));
    });
}

// Cached DOM refs for per-frame functions (avoid getElementById every frame)
let _cachedPlayhead = null;
let _cachedTimelineScroll = null;
let _cachedTimelineTime = null;

function updatePlayhead() {
    if (!_cachedPlayhead) _cachedPlayhead = document.getElementById('playhead');
    if (!_cachedTimelineScroll) _cachedTimelineScroll = document.getElementById('timeline-scroll');
    if (!_cachedPlayhead || !_cachedTimelineScroll) return;

    // Calculate position relative to viewport
    const absoluteX = TRACK_HEADER_WIDTH + (state.currentTime * state.timeline.zoom);
    const visibleX = absoluteX - _cachedTimelineScroll.scrollLeft;

    _cachedPlayhead.style.left = `${visibleX}px`;
    _cachedPlayhead.style.display = visibleX < TRACK_HEADER_WIDTH - 10 ? 'none' : 'block';
}

function updateTimeDisplay() {
    if (!_cachedTimelineTime) _cachedTimelineTime = document.getElementById('timeline-time');
    if (_cachedTimelineTime) _cachedTimelineTime.textContent = `${formatTime(state.currentTime)} / ${formatTime(state.totalDuration)}`;
}

async function scrubMedia(time) {
    const audio = elements.previewAudio;

    // Stop playback while scrubbing
    if (state.isPlaying) {
        stopPlayback();
    }

    // Update audio position
    if (audio?.src) {
        audio.currentTime = Math.min(time, audio.duration || state.totalDuration);
    }

    // Update state current time
    state.currentTime = time;

    // Load all active scenes at this time
    await loadActiveScenes();

    // Get active scenes for highlighting
    const activeScenes = getActiveScenesAtTime(time);
    updateSceneHighlight(activeScenes.length > 0 ? activeScenes[0].index : -1);
}

// ========================================
// Clip Dragging
// ========================================

// Get snap points from all clips except the one being dragged
function getSnapPoints(excludeIndex, trackId) {
    const points = [0]; // Always snap to start

    state.scenes.forEach((scene, i) => {
        if (i === excludeIndex) return;
        // Only snap to clips on same track or all tracks if holding shift
        if (scene.trackId === trackId || trackId === null) {
            points.push(scene.startTime);
            points.push(scene.endTime);
        }
    });

    // Add playhead position
    points.push(state.currentTime);

    // Add total duration
    points.push(state.totalDuration);

    return [...new Set(points)].sort((a, b) => a - b);
}

// Find nearest snap point
function findSnapPoint(time, clipDuration, excludeIndex, trackId) {
    if (!state.snapEnabled) return { start: time, snapped: false };

    const snapPoints = getSnapPoints(excludeIndex, trackId);
    const threshold = state.snapThreshold / state.timeline.zoom; // Convert pixels to time

    // Check snap for clip start
    for (const point of snapPoints) {
        if (Math.abs(time - point) < threshold) {
            return { start: point, snapped: true, snapTo: 'start' };
        }
    }

    // Check snap for clip end
    const clipEnd = time + clipDuration;
    for (const point of snapPoints) {
        if (Math.abs(clipEnd - point) < threshold) {
            return { start: point - clipDuration, snapped: true, snapTo: 'end' };
        }
    }

    return { start: time, snapped: false };
}

function startDragClip(e, clip) {
    e.stopPropagation();
    const idx = parseInt(clip.dataset.index);
    const scene = state.scenes[idx];
    const startX = e.clientX;
    const origTime = scene.startTime;
    const origTrackId = scene.trackId || 'video-track-1';
    const clipDuration = scene.endTime - scene.startTime;
    let moved = false;
    let undoPushed = false;
    let lastSnapped = false;
    clip.classList.add('dragging');

    // Create snap indicator line
    let snapLine = document.createElement('div');
    snapLine.className = 'snap-indicator';
    snapLine.style.display = 'none';
    document.querySelector('.timeline-body')?.appendChild(snapLine);

    const onMove = (me) => {
        if (!moved && !undoPushed) { pushUndoState(); undoPushed = true; }
        moved = true;
        const delta = (me.clientX - startX) / state.timeline.zoom;
        let newTime = Math.max(0, origTime + delta);

        // Apply snapping
        const snapResult = findSnapPoint(newTime, clipDuration, idx, scene.trackId);
        newTime = snapResult.start;

        // Show/hide snap indicator
        if (snapResult.snapped && !lastSnapped) {
            clip.classList.add('snapping');
            const snapX = (snapResult.snapTo === 'end' ? newTime + clipDuration : newTime) * state.timeline.zoom + TRACK_HEADER_WIDTH;
            snapLine.style.left = `${snapX - document.getElementById('timeline-scroll').scrollLeft}px`;
            snapLine.style.display = 'block';
        } else if (!snapResult.snapped && lastSnapped) {
            clip.classList.remove('snapping');
            snapLine.style.display = 'none';
        }
        lastSnapped = snapResult.snapped;

        clip.style.left = `${newTime * state.timeline.zoom}px`;
    };

    const onUp = (ue) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        clip.classList.remove('dragging');
        clip.classList.remove('snapping');
        snapLine.remove();

        if (!moved) return;

        const delta = (ue.clientX - startX) / state.timeline.zoom;
        let newTime = Math.max(0, origTime + delta);

        // Apply snapping on release
        const snapResult = findSnapPoint(newTime, clipDuration, idx, scene.trackId);
        newTime = Math.max(0, snapResult.start);

        scene.startTime = newTime;
        scene.endTime = newTime + clipDuration;

        // Only allow dropping on tracks of the same type (video->video, audio->audio)
        const target = document.elementsFromPoint(ue.clientX, ue.clientY).find(el => el.classList.contains('track-content'));
        if (target) {
            const targetTrackId = target.dataset.track;
            const sourceTrack = state.timeline.tracks.find(t => t.id === origTrackId);
            const targetTrack = state.timeline.tracks.find(t => t.id === targetTrackId);
            // Only switch track if types match
            if (sourceTrack && targetTrack && sourceTrack.type === targetTrack.type) {
                scene.trackId = targetTrackId;
            }
            // Otherwise keep original track
        }

        state.scenes.sort((a, b) => a.startTime - b.startTime);
        renderTimeline();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

function startDragAudioClip(e, clip) {
    e.stopPropagation();
    const startX = e.clientX;
    const origOffset = state.audioClipOffset || 0;
    const origTrack = state.audioClipTrack || 'audio-track';
    let moved = false;
    let undoPushed = false;
    clip.classList.add('dragging');

    const onMove = (me) => {
        if (!moved && !undoPushed) { pushUndoState(); undoPushed = true; }
        moved = true;
        const delta = (me.clientX - startX) / state.timeline.zoom;
        const newOffset = Math.max(0, origOffset + delta);
        clip.style.left = `${newOffset * state.timeline.zoom}px`;
    };

    const onUp = (ue) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        clip.classList.remove('dragging');

        if (!moved) return;

        const delta = (ue.clientX - startX) / state.timeline.zoom;
        state.audioClipOffset = Math.max(0, origOffset + delta);

        // Only allow dropping on audio-type tracks
        const target = document.elementsFromPoint(ue.clientX, ue.clientY).find(el => el.classList.contains('track-content'));
        if (target) {
            const targetTrackId = target.dataset.track;
            const targetTrack = state.timeline.tracks.find(t => t.id === targetTrackId);
            if (targetTrack && targetTrack.type === 'audio') {
                state.audioClipTrack = targetTrackId;
            }
        }

        renderTimeline();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// ========================================
// Clip Edge Trimming
// ========================================
function startTrimClip(e, handle) {
    e.preventDefault();
    const idx = parseInt(handle.dataset.index);
    const edge = handle.dataset.edge; // 'left' or 'right'
    const scene = state.scenes[idx];
    if (!scene) return;

    const startX = e.clientX;
    const origStartTime = scene.startTime;
    const origEndTime = scene.endTime;
    const origMediaOffset = scene.mediaOffset || 0;
    const minDuration = 0.2; // minimum clip duration in seconds
    let moved = false;
    let undoPushed = false;

    const clipEl = handle.closest('.timeline-clip');
    if (clipEl) clipEl.classList.add('trimming');
    document.body.style.cursor = edge === 'left' ? 'w-resize' : 'e-resize';

    const onMove = (me) => {
        if (!moved && !undoPushed) { pushUndoState(); undoPushed = true; }
        moved = true;
        const delta = (me.clientX - startX) / state.timeline.zoom;

        if (edge === 'left') {
            // Trimming left edge: move startTime, adjust mediaOffset
            let newStart = Math.max(0, origStartTime + delta);
            // Enforce minimum duration
            if (origEndTime - newStart < minDuration) newStart = origEndTime - minDuration;
            // Can't go before original media start (mediaOffset can't go negative)
            const mediaOffsetDelta = newStart - origStartTime;
            if (origMediaOffset + mediaOffsetDelta < 0) newStart = origStartTime - origMediaOffset;

            scene.startTime = newStart;
            scene.mediaOffset = origMediaOffset + (newStart - origStartTime);

            // Update clip element live
            if (clipEl) {
                clipEl.style.left = `${newStart * state.timeline.zoom}px`;
                clipEl.style.width = `${(scene.endTime - newStart) * state.timeline.zoom}px`;
            }
        } else {
            // Trimming right edge: just move endTime
            let newEnd = origEndTime + delta;
            // Enforce minimum duration
            if (newEnd - origStartTime < minDuration) newEnd = origStartTime + minDuration;
            // Don't allow negative or zero
            newEnd = Math.max(origStartTime + minDuration, newEnd);

            scene.endTime = newEnd;

            // Update clip element live
            if (clipEl) {
                clipEl.style.width = `${(newEnd - origStartTime) * state.timeline.zoom}px`;
            }
        }
    };

    const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        if (clipEl) clipEl.classList.remove('trimming');

        if (!moved) return;

        state.scenes.sort((a, b) => a.startTime - b.startTime);
        recalcTotalDuration();
        renderTimeline();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// ========================================
// Playback Control
// ========================================

// Helper to wait for video to be ready
function waitForVideoReady(video, timeout = 3000) {
    return new Promise((resolve) => {
        if (video.readyState >= 2) {
            resolve();
            return;
        }
        const timeoutId = setTimeout(() => {
            video.removeEventListener('canplay', onReady);
            video.removeEventListener('loadeddata', onReady);
            resolve(); // Resolve anyway after timeout
        }, timeout);

        const onReady = () => {
            clearTimeout(timeoutId);
            video.removeEventListener('canplay', onReady);
            video.removeEventListener('loadeddata', onReady);
            resolve();
        };

        video.addEventListener('canplay', onReady);
        video.addEventListener('loadeddata', onReady);
    });
}

// Clean up video event handlers
function cleanupVideoHandlers() {
    // Clean up handlers from all track videos (both A and B buffers)
    [elements.videoTrack1, elements.videoTrack2, elements.videoTrack3,
     elements.videoTrack1B, elements.videoTrack2B, elements.videoTrack3B].forEach(video => {
        if (video) {
            video.ontimeupdate = null;
            video.onended = null;
            video.onplay = null;
            video.onpause = null;
            video.onerror = null;
            video.onloadeddata = null;
        }
    });
}

async function jumpToScene(index) {
    if (index < 0 || index >= state.scenes.length) return;

    const wasPlaying = state.isPlaying;
    const audio = elements.previewAudio;
    const scene = state.scenes[index];

    // Stop current playback temporarily
    if (wasPlaying) {
        stopPlayback();
    }

    // Clean up old handlers
    cleanupVideoHandlers();

    state.currentTime = scene.startTime;

    // Update UI
    updateSceneHighlight(index);
    updatePlayhead();
    updateTimeDisplay();

    // Sync audio position
    if (audio?.src) {
        audio.currentTime = Math.min(scene.startTime, audio.duration || state.totalDuration);
    }

    // Load all active scenes at this time
    await loadActiveScenes();

    // Resume playback if we were playing
    if (wasPlaying) {
        startPlayback();
    }
}

async function seekToTime(time) {
    const wasPlaying = state.isPlaying;

    // Stop playback during seek
    if (wasPlaying) {
        stopPlayback();
    }

    state.currentTime = Math.max(0, time);

    // Clean up old handlers
    cleanupVideoHandlers();

    // Load all active scenes at this time
    if (state.compositorActive && state.compositor && state.compositor.isInitialized) {
        // WebGL2 compositor: just render the frame
        state.compositor.renderAtTime(state.currentTime);
    } else {
        await loadActiveScenes();
    }

    // Sync audio
    const audio = elements.previewAudio;
    if (audio?.src) {
        audio.currentTime = Math.min(state.currentTime, audio.duration || state.totalDuration);
    }

    // Get active scenes for highlighting
    const activeScenes = getActiveScenesAtTime(state.currentTime);
    updateSceneHighlight(activeScenes.length > 0 ? activeScenes[0].index : -1);
    updatePlayhead();
    updateTimeDisplay();
    if (!state.compositorActive) updateMGOverlay();

    // Resume if was playing and within content
    if (wasPlaying && activeScenes.length > 0) {
        startPlayback();
    }
}

function getSceneAtTime(time) {
    for (let i = state.scenes.length - 1; i >= 0; i--) {
        if (time >= state.scenes[i].startTime && time < state.scenes[i].endTime) return i;
    }
    // Allow sitting exactly at the end of the last scene
    if (state.scenes.length > 0) {
        const last = state.scenes[state.scenes.length - 1];
        if (Math.abs(time - last.endTime) < 0.05) return state.scenes.length - 1;
    }
    return -1;
}

/**
 * Update Ken Burns transform on an image element based on current time
 */
function updateKenBurnsTransform(img, scene) {
    // If Ken Burns disabled for this scene, just apply scene transform
    if (scene.kenBurnsEnabled === false) {
        const sceneScale = scene.scale !== undefined ? scene.scale : 1;
        const scenePosX = scene.posX || 0;
        const scenePosY = scene.posY || 0;
        img.style.transform = `translate(${scenePosX}%, ${scenePosY}%) scale(${sceneScale})`;
        img.style.transformOrigin = 'center center';
        // Crop on img, radius on wrapper
        applyCrop(img, scene);
        const tn = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
        const wr = elements[`trackWrapper${tn}`];
        if (wr) { applyRadius(wr, scene); wr.style.clipPath = ''; }
        return;
    }
    const originalIndex = scene.index !== undefined ? scene.index : 0;
    const kbTypes = [
        'zoomIn', 'zoomOut',
        'panLeft', 'panRight', 'panUp', 'panDown',
        'zoomPanRight', 'zoomPanLeft',
        'zoomOutPanRight', 'zoomOutPanLeft',
        'driftTopLeftToBottomRight', 'driftBottomRightToTopLeft',
        'driftTopRightToBottomLeft', 'driftBottomLeftToTopRight',
    ];
    const kbType = kbTypes[(originalIndex * 13 + 7) % kbTypes.length];
    const sceneDur = scene.endTime - scene.startTime;
    // Linear motion - constant speed, feels like an endless camera drift
    const p = sceneDur > 0 ? Math.max(0, Math.min(1, (state.currentTime - scene.startTime) / sceneDur)) : 0;
    // Gentle Ken Burns for contain mode (charts, infographics stay mostly visible)
    const gentle = scene.fitMode === 'contain';
    const s = gentle ? 0.4 : 1; // scale factor for gentle mode
    let kbTransform = '';
    switch (kbType) {
        case 'zoomIn': kbTransform = `scale(${1 + (0.03 + p * 0.12) * s})`; break;
        case 'zoomOut': kbTransform = `scale(${1 + (0.15 - p * 0.12) * s})`; break;
        case 'panLeft': kbTransform = `scale(${1 + 0.12 * s}) translateX(${(3 - p * 6) * s}%)`; break;
        case 'panRight': kbTransform = `scale(${1 + 0.12 * s}) translateX(${(-3 + p * 6) * s}%)`; break;
        case 'panUp': kbTransform = `scale(${1 + 0.12 * s}) translateY(${(3 - p * 6) * s}%)`; break;
        case 'panDown': kbTransform = `scale(${1 + 0.12 * s}) translateY(${(-3 + p * 6) * s}%)`; break;
        case 'zoomPanRight': kbTransform = `scale(${1 + (0.05 + p * 0.1) * s}) translateX(${(-2 + p * 4) * s}%)`; break;
        case 'zoomPanLeft': kbTransform = `scale(${1 + (0.05 + p * 0.1) * s}) translateX(${(2 - p * 4) * s}%)`; break;
        case 'zoomOutPanRight': kbTransform = `scale(${1 + (0.15 - p * 0.08) * s}) translateX(${(-2 + p * 4) * s}%)`; break;
        case 'zoomOutPanLeft': kbTransform = `scale(${1 + (0.15 - p * 0.08) * s}) translateX(${(2 - p * 4) * s}%)`; break;
        case 'driftTopLeftToBottomRight': kbTransform = `scale(${1 + 0.15 * s}) translateX(${(-2 + p * 4) * s}%) translateY(${(-2 + p * 4) * s}%)`; break;
        case 'driftBottomRightToTopLeft': kbTransform = `scale(${1 + 0.15 * s}) translateX(${(2 - p * 4) * s}%) translateY(${(2 - p * 4) * s}%)`; break;
        case 'driftTopRightToBottomLeft': kbTransform = `scale(${1 + 0.15 * s}) translateX(${(2 - p * 4) * s}%) translateY(${(-2 + p * 4) * s}%)`; break;
        case 'driftBottomLeftToTopRight': kbTransform = `scale(${1 + 0.15 * s}) translateX(${(-2 + p * 4) * s}%) translateY(${(2 - p * 4) * s}%)`; break;
    }
    // Combine Ken Burns with scene scale/position
    const sceneScale = scene.scale !== undefined ? scene.scale : 1;
    const scenePosX = scene.posX || 0;
    const scenePosY = scene.posY || 0;
    const sceneTransform = `translate(${scenePosX}%, ${scenePosY}%) scale(${sceneScale})`;
    img.style.transform = kbTransform ? `${sceneTransform} ${kbTransform}` : sceneTransform;
    img.style.transformOrigin = 'center center';
    // Crop on img, radius on wrapper
    applyCrop(img, scene);
    const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
    const wrapper = elements[`trackWrapper${trackNum}`];
    if (wrapper) { applyRadius(wrapper, scene); wrapper.style.clipPath = ''; }
}

/**
 * Apply crop (clip-path) and border-radius to an element
 */
/**
 * Apply crop (clip-path) to a media element (video/img).
 * Crop is on the media so scaling can push cropped edges out of view.
 */
function applyCrop(el, scene) {
    const cropTop = scene.cropTop || 0;
    const cropRight = scene.cropRight || 0;
    const cropBottom = scene.cropBottom || 0;
    const cropLeft = scene.cropLeft || 0;
    if (cropTop || cropRight || cropBottom || cropLeft) {
        el.style.clipPath = `inset(${cropTop}% ${cropRight}% ${cropBottom}% ${cropLeft}%)`;
    } else {
        el.style.clipPath = '';
    }
}

/**
 * Apply border-radius to a wrapper element.
 * Radius is on the wrapper so it clips the entire content area cleanly.
 */
function applyRadius(el, scene) {
    const borderRadius = scene.borderRadius || 0;
    if (borderRadius) {
        el.style.borderRadius = `${borderRadius}%`;
        el.style.overflow = 'hidden';
    } else {
        el.style.borderRadius = '';
        el.style.overflow = '';
    }
}

/**
 * Get cached media URL for a scene (avoids repeated IPC calls)
 */
async function getCachedMediaUrl(sceneIndex, mediaExtension, type) {
    const cacheKey = `${sceneIndex}:${mediaExtension || ''}:${type || 'scene'}`;
    if (state._mediaUrlCache[cacheKey]) return state._mediaUrlCache[cacheKey];

    let mediaPath;
    if (type === 'overlay') {
        mediaPath = await window.electronAPI.getSceneMediaPath(sceneIndex, mediaExtension || '.mp4', 'overlay');
    } else {
        mediaPath = await window.electronAPI.getSceneMediaPath(sceneIndex, mediaExtension);
    }
    if (!mediaPath) {
        console.warn(`[MediaCache] No path for scene ${sceneIndex} ext=${mediaExtension} type=${type || 'scene'}`);
        return null;
    }
    const mediaUrl = await window.electronAPI.getFileUrl(mediaPath);
    if (mediaUrl) {
        state._mediaUrlCache[cacheKey] = mediaUrl;
    } else {
        console.warn(`[MediaCache] No URL for path: ${mediaPath}`);
    }
    return mediaUrl;
}

/**
 * Pre-buffer the NEXT video clip into each track's buffer element.
 * This ensures instant swap when the scene changes during playback.
 * URLs are pre-cached at plan load time; this loads the actual video data.
 */
function preloadUpcomingScenes(currentTime, force) {
    // Throttle: only check every 250ms (or immediately if forced)
    const now = performance.now();
    if (!force && now - state._lastPreloadCheck < 250) return;
    state._lastPreloadCheck = now;

    for (const tn of ['1', '2', '3']) {
        const trackId = `video-track-${tn}`;
        const { buffer } = getTrackVideoPair(tn);
        if (!buffer) continue;
        // Skip if this track has a swap pending (buffer is in use)
        if (state._trackSwapPending[tn]) continue;

        // Find the next video scene on this track (starts after current time, within 15s)
        const nextScene = state.scenes.find(s =>
            s.trackId === trackId &&
            !s.isMGScene && !s.disabled &&
            s.mediaType !== 'image' &&
            s.startTime > currentTime &&
            s.startTime - currentTime < 15
        );
        if (!nextScene) continue;

        const idx = nextScene.index !== undefined ? nextScene.index : state.scenes.indexOf(nextScene);
        const cacheKey = `${idx}:${nextScene.mediaExtension || ''}:scene`;
        const url = state._mediaUrlCache[cacheKey];

        if (url && buffer._loadedUrl !== url) {
            console.log(`[PreBuffer] Preloading scene ${idx} into track ${tn} buffer`);
            buffer.src = url;
            buffer._loadedUrl = url;
            buffer.load();
        }
    }
}

/**
 * Load all scenes that are active at the current time across all tracks
 */
async function loadActiveScenes(activeScenes) {
    // Use passed-in activeScenes to avoid duplicate getActiveScenesAtTime call
    if (!activeScenes) activeScenes = getActiveScenesAtTime(state.currentTime);

    // Determine which tracks have active scenes
    const activeTracks = new Set();
    activeScenes.forEach(({ scene }) => {
        if (!scene.isMGScene && !scene.disabled) {
            const tn = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
            activeTracks.add(tn);
        }
    });

    // Only hide tracks that are NOT active (avoids unnecessary DOM thrashing)
    ['1', '2', '3'].forEach(tn => {
        if (!activeTracks.has(tn)) {
            const videoA = elements[`videoTrack${tn}`];
            const videoB = elements[`videoTrack${tn}B`];
            const img = elements[`imgTrack${tn}`];
            if (videoA) videoA.classList.remove('active');
            if (videoB) videoB.classList.remove('active');
            if (img) {
                img.classList.remove('active');
                img.style.transform = '';
                img.style.objectFit = '';
            }
        }
    });
    // Hide background layer (will be re-shown if needed below)
    if (elements.bgVideo) elements.bgVideo.classList.remove('active');
    if (elements.bgImage) elements.bgImage.classList.remove('active');
    if (elements.bgGradient) elements.bgGradient.classList.remove('active');

    if (activeScenes.length === 0) {
        // No active scenes - hide video container, show placeholder
        if (elements.videoContainer) {
            elements.videoContainer.classList.add('hidden');
        }
        if (elements.videoControls) {
            elements.videoControls.classList.add('hidden');
        }
        elements.previewPlaceholder.classList.remove('hidden');
        return;
    }

    // Show video container
    elements.previewPlaceholder.classList.add('hidden');
    if (elements.videoContainer) {
        elements.videoContainer.classList.remove('hidden');
    }
    if (elements.videoControls) {
        elements.videoControls.classList.remove('hidden');
    }

    // Clear V3 MG preview layer if exists
    const mgV3Layer = document.getElementById('mg-v3-preview');
    if (mgV3Layer) {
        mgV3Layer.classList.remove('active');
        mgV3Layer.innerHTML = '';
    }

    // Load and show each active scene on its track (in parallel for speed)
    const sceneLoadPromises = [];
    for (const { scene, index } of activeScenes) {
        if (scene.disabled) continue; // Skip disabled clips

        // Full-screen MG scene on V3: render as HTML overlay (synchronous, no IPC)
        if (scene.isMGScene) {
            if (state.mutedTracks['video-track-3']) continue;
            const video3A = elements.videoTrack3;
            const video3B = elements.videoTrack3B;
            const img3 = elements.imgTrack3;
            if (video3A) video3A.classList.remove('active');
            if (video3B) video3B.classList.remove('active');
            if (img3) img3.classList.remove('active');

            const layer = document.getElementById('mg-v3-preview');
            if (layer) {
                layer.classList.add('active');
                const html = renderFullscreenMGPreview(scene);
                layer.innerHTML = html;
            }
            continue;
        }

        // Each scene loads in parallel (async IPC calls run concurrently)
        sceneLoadPromises.push((async () => { try {
            const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
            const img = elements[`imgTrack${trackNum}`];
            const isImage = scene.mediaType === 'image';

            const originalIndex = scene.index !== undefined ? scene.index : index;
            const mediaUrl = await getCachedMediaUrl(originalIndex, scene.mediaExtension);
            if (!mediaUrl) {
                console.warn(`[Preview] Scene ${index} (track ${trackNum}): no media URL found for index=${originalIndex} ext=${scene.mediaExtension}`);
                return;
            }

            console.log(`[Preview] Loading scene ${index} on track ${trackNum}, isImage=${isImage}, url=${mediaUrl.substring(mediaUrl.lastIndexOf('/') + 1)}`);

            if (isImage && img) {
                // IMAGE SCENE: show img, hide both video buffers for this track
                const videoA = elements[`videoTrack${trackNum}`];
                const videoB = elements[`videoTrack${trackNum}B`];
                if (videoA) videoA.classList.remove('active');
                if (videoB) videoB.classList.remove('active');
                img.style.objectFit = scene.fitMode || 'cover';

                const imgSourceChanging = img.src !== mediaUrl;

                if (imgSourceChanging && img.src && state.isPlaying && !state.transition.isTransitioning) {
                    const transOutImg = elements.imgTransitionOut;
                    const container = elements.videoContainer;
                    if (transOutImg && container) {
                        transOutImg.style.zIndex = parseInt(trackNum) + 5;
                        img.classList.add('active');
                        performImageTransition(img, transOutImg, scene, mediaUrl);
                    }
                } else {
                    if (imgSourceChanging) img.src = mediaUrl;
                    updateKenBurnsTransform(img, scene);
                    img.classList.add('active');
                }
            } else {
                // VIDEO SCENE: double-buffer swap for lag-free playback
                if (img) img.classList.remove('active');

                const { active: activeVid, buffer: bufferVid } = getTrackVideoPair(trackNum);
                const sceneTime = (state.currentTime - scene.startTime) + (scene.mediaOffset || 0);

                if (activeVid._loadedUrl === mediaUrl) {
                    // Same source already active — just sync time
                    if (Math.abs(activeVid.currentTime - sceneTime) > 0.15) {
                        activeVid.currentTime = sceneTime;
                    }
                    activeVid.volume = getSceneVolume(scene);
                    activeVid.muted = false;
                    activeVid.classList.add('active');
                    applySceneTransformToVideo(activeVid, scene);
                    if (state.isPlaying && activeVid.paused) {
                        activeVid.play().catch(() => {});
                    }
                } else if (bufferVid._loadedUrl === mediaUrl && bufferVid.readyState >= 2) {
                    // Buffer has this source pre-loaded and ready
                    const transOut = elements.videoTransitionOut;
                    const shouldAnimate = state.isPlaying && !state.transition.isTransitioning
                        && activeVid._loadedUrl && transOut;

                    if (shouldAnimate) {
                        // Animated transition — load into dedicated transition-out element
                        // (browser cache serves it instantly since buffer already fetched it)
                        console.log(`[DoubleBuffer] Animated transition on track ${trackNum}`);
                        state._trackSwapPending[trackNum] = true;

                        transOut.src = mediaUrl;
                        transOut.load();
                        transOut.currentTime = sceneTime;
                        transOut.volume = getSceneVolume(scene);
                        transOut.muted = false;
                        transOut.style.zIndex = parseInt(trackNum) + 5;
                        applySceneTransformToVideo(transOut, scene);

                        // Fire-and-forget — performTrackTransition manages its own lifecycle
                        performTrackTransition(activeVid, transOut, originalIndex, mediaUrl, scene)
                            .then(() => {
                                state._trackSwapPending[trackNum] = false;
                                // After transition, activeVid has new source — update tracking
                                activeVid._loadedUrl = mediaUrl;
                                bufferVid._loadedUrl = null; // free buffer for next preload
                            }).catch(() => {
                                state._trackSwapPending[trackNum] = false;
                            });
                    } else {
                        // Instant swap (not playing, already transitioning, or scrubbing)
                        console.log(`[DoubleBuffer] Instant swap on track ${trackNum}: buffer ready`);
                        activeVid.classList.remove('active');
                        activeVid.pause();

                        bufferVid.currentTime = sceneTime;
                        bufferVid.volume = getSceneVolume(scene);
                        bufferVid.muted = false;
                        bufferVid.classList.add('active');
                        applySceneTransformToVideo(bufferVid, scene);
                        if (state.isPlaying) bufferVid.play().catch(() => {});

                        swapTrackActive(trackNum);
                    }
                } else if (!activeVid._loadedUrl) {
                    // First load on this track — load directly into active element
                    console.log(`[DoubleBuffer] First load on track ${trackNum}`);
                    activeVid.src = mediaUrl;
                    activeVid._loadedUrl = mediaUrl;
                    activeVid.load();
                    activeVid.currentTime = sceneTime;
                    activeVid.volume = getSceneVolume(scene);
                    activeVid.muted = false;
                    activeVid.classList.add('active');
                    applySceneTransformToVideo(activeVid, scene);
                    if (state.isPlaying && activeVid.paused) {
                        activeVid.play().catch(() => {});
                    }
                } else {
                    // Fallback: NON-BLOCKING — old clip stays visible while buffer loads
                    // The swap happens asynchronously when buffer is ready (no await)
                    console.log(`[DoubleBuffer] Deferred swap on track ${trackNum} (buffer miss)`);
                    state._trackSwapPending[trackNum] = true;

                    // Only re-load if buffer doesn't already have this URL
                    if (bufferVid._loadedUrl !== mediaUrl) {
                        bufferVid.src = mediaUrl;
                        bufferVid._loadedUrl = mediaUrl;
                        bufferVid.load();
                    }

                    // Fire-and-forget: swap when buffer is ready
                    let swapped = false;
                    const doSwap = () => {
                        if (swapped) return;
                        swapped = true;
                        // Guard: if scene is no longer active (user seeked), skip stale swap
                        if (state.currentTime < scene.startTime || state.currentTime >= scene.endTime) {
                            state._trackSwapPending[trackNum] = false;
                            return;
                        }
                        // Use CURRENT time (not stale sceneTime from when load started)
                        const now = (state.currentTime - scene.startTime) + (scene.mediaOffset || 0);
                        activeVid.classList.remove('active');
                        activeVid.pause();

                        bufferVid.currentTime = Math.max(0, now);
                        bufferVid.volume = getSceneVolume(scene);
                        bufferVid.muted = false;
                        bufferVid.classList.add('active');
                        applySceneTransformToVideo(bufferVid, scene);
                        if (state.isPlaying) bufferVid.play().catch(() => {});

                        swapTrackActive(trackNum);
                        state._trackSwapPending[trackNum] = false;
                    };
                    if (bufferVid.readyState >= 2) {
                        doSwap();
                    } else {
                        bufferVid.addEventListener('canplay', doSwap, { once: true });
                        setTimeout(doSwap, 300); // short timeout — old clip plays naturally meanwhile
                    }
                    // Don't await — loadActiveScenes returns immediately, old clip keeps playing
                }
            }
        } catch (e) {
            console.error('[Preview] Failed to load scene media:', e);
        }
        })());
    }
    // Wait for all scene loads to complete in parallel
    if (sceneLoadPromises.length > 0) await Promise.all(sceneLoadPromises);

    // ===== Background layer rendering =====
    // Find primary visible scene (lowest track, non-overlay, non-MG) and show its background
    const primaryScene = activeScenes.find(s => !s.scene.isMGScene && !s.scene.disabled);
    if (primaryScene && primaryScene.scene.background && primaryScene.scene.background !== 'none') {
        const bgType = primaryScene.scene.background;
        const scene = primaryScene.scene;

        if (bgType === 'blur') {
            // Blur mode: duplicate the same video/image source behind it
            if (elements.bgGradient) elements.bgGradient.classList.remove('active');
            const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
            const activeVideo = getActiveTrackVideo(trackNum);
            const img = elements[`imgTrack${trackNum}`];
            const isImage = scene.mediaType === 'image';

            if (isImage && img && img.src) {
                // Blur background from image source
                if (elements.bgVideo) elements.bgVideo.classList.remove('active');
                if (elements.bgImage) {
                    if (elements.bgImage.src !== img.src) elements.bgImage.src = img.src;
                    elements.bgImage.style.filter = 'blur(25px)';
                    elements.bgImage.style.transform = 'scale(1.3)';
                    elements.bgImage.classList.add('active');
                }
            } else if (activeVideo && activeVideo.src) {
                // Blur background from video source
                // During playback, DEFER bgVideo.load() to avoid competing with buffer decode
                if (elements.bgImage) elements.bgImage.classList.remove('active');
                if (elements.bgVideo) {
                    if (elements.bgVideo.src !== activeVideo.src) {
                        if (state.isPlaying) {
                            // Defer: just mark the URL, load lazily on next pause/seek
                            elements.bgVideo._pendingSrc = activeVideo.src;
                            elements.bgVideo.classList.add('active');
                        } else {
                            elements.bgVideo.src = activeVideo.src;
                            elements.bgVideo._pendingSrc = null;
                            elements.bgVideo.load();
                        }
                    }
                    if (elements.bgVideo.src && !elements.bgVideo._pendingSrc) {
                        elements.bgVideo.currentTime = activeVideo.currentTime;
                    }
                    elements.bgVideo.classList.add('active');
                    if (state.isPlaying && elements.bgVideo.paused && elements.bgVideo.src) elements.bgVideo.play().catch(() => {});
                }
            }
        } else if (bgType.startsWith('pattern:')) {
            // Pattern mode: show a background file from assets/backgrounds/
            if (elements.bgGradient) elements.bgGradient.classList.remove('active');
            const filename = bgType.replace('pattern:', '');
            const bg = state.availableBackgrounds.find(b => b.filename === filename);
            if (bg) {
                try {
                    const bgUrl = await window.electronAPI.getBackgroundUrl(filename);
                    if (bgUrl) {
                        const isImage = bg.mediaType === 'image';
                        if (isImage) {
                            if (elements.bgVideo) elements.bgVideo.classList.remove('active');
                            if (elements.bgImage) {
                                if (elements.bgImage.src !== bgUrl) elements.bgImage.src = bgUrl;
                                elements.bgImage.style.filter = '';
                                elements.bgImage.style.transform = '';
                                elements.bgImage.classList.add('active');
                            }
                        } else {
                            if (elements.bgImage) elements.bgImage.classList.remove('active');
                            if (elements.bgVideo) {
                                if (elements.bgVideo.src !== bgUrl) {
                                    elements.bgVideo.src = bgUrl;
                                    elements.bgVideo.load();
                                }
                                elements.bgVideo.style.filter = '';
                                elements.bgVideo.style.transform = '';
                                elements.bgVideo.classList.add('active');
                                if (state.isPlaying && elements.bgVideo.paused) elements.bgVideo.play().catch(() => {});
                            }
                        }
                    }
                } catch (e) { /* best effort */ }
            }
        } else if (bgType.startsWith('gradient:')) {
            // Gradient mode: show a CSS gradient from the built-in library
            const gradientId = bgType.replace('gradient:', '');
            const gradientCSS = GRADIENT_BACKGROUNDS[gradientId];
            if (gradientCSS && elements.bgGradient) {
                if (elements.bgVideo) elements.bgVideo.classList.remove('active');
                if (elements.bgImage) elements.bgImage.classList.remove('active');
                elements.bgGradient.style.background = gradientCSS;
                elements.bgGradient.classList.add('active');
            }
        }
    }

    // Update MG overlay for current time
    updateMGOverlay();
}

function setupVideoPlayback(scene) {
    // Multi-track system: playback handled in the main playback loop
    // This function is kept for compatibility but is now a no-op
    // All video loading and syncing happens in loadActiveScenes() and the playback loop
}

let _lastHighlightIndex = -1;
function updateSceneHighlight(index) {
    // Skip if highlight hasn't changed
    if (index === _lastHighlightIndex) return;
    _lastHighlightIndex = index;
    document.querySelectorAll('.scene-card').forEach((c, i) => c.classList.toggle('active', i === index));
    document.querySelectorAll('.timeline-clip[data-index]').forEach(c => c.classList.toggle('active', parseInt(c.dataset.index) === index));
}

// ========================================
// Render Video
// ========================================
// ========================================
// WebGL2 Compositor Engine Integration
// ========================================

/**
 * Initialize the WebGL2 compositor engine.
 * Called once during init() — creates the engine but does NOT activate it.
 */
function initCompositor() {
    const canvas = document.getElementById('compositor-canvas');
    if (!canvas) {
        console.warn('[Compositor] Canvas element not found');
        return;
    }

    try {
        state.compositor = new Compositor(canvas, {
            width: 1920, height: 1080, fps: 30,
        });
        console.log('[Compositor] Engine created (not yet active)');

        // Wire up the compositor toggle button
        const toggleBtn = document.getElementById('btn-compositor-toggle');
        if (toggleBtn) {
            toggleBtn.style.display = 'inline-block';
            toggleBtn.addEventListener('click', () => {
                setCompositorMode(!state.compositorActive);
            });
        }

        // Auto-activate when WebGL2 renderer is selected
        const rendererSelect = document.getElementById('renderer-select');
        if (rendererSelect) {
            rendererSelect.addEventListener('change', () => {
                if (rendererSelect.value === 'webgl2' && !state.compositorActive) {
                    setCompositorMode(true);
                }
            });
        }
    } catch (e) {
        console.error('[Compositor] Failed to create engine:', e);
        state.compositor = null;
    }
}

/**
 * Toggle between HTML preview and WebGL2 compositor preview.
 */
function setCompositorMode(active) {
    state.compositorActive = active;
    const canvas = document.getElementById('compositor-canvas');
    const htmlLayers = document.querySelectorAll('.track-wrapper, .mg-overlay, .mg-v3-preview-layer, .bg-media');
    const toggleBtn = document.getElementById('btn-compositor-toggle');

    if (active) {
        // Initialize if not yet done
        if (state.compositor && !state.compositor.isInitialized) {
            state.compositor.init();
        }
        // Load plan into compositor if we have one
        if (state.compositor && state.videoPlan) {
            loadPlanIntoCompositor();
        }
        if (canvas) canvas.classList.add('active');
        htmlLayers.forEach(el => el.style.visibility = 'hidden');
        if (toggleBtn) {
            toggleBtn.textContent = 'Engine: ON';
            toggleBtn.style.background = '#22c55e';
            toggleBtn.style.color = '#000';
        }
        // Render current frame immediately
        if (state.compositor && state.compositor.isInitialized) {
            state.compositor.renderAtTime(state.currentTime);
        }
        console.log('[Compositor] Preview mode ENABLED');
    } else {
        if (canvas) canvas.classList.remove('active');
        htmlLayers.forEach(el => el.style.visibility = '');
        if (toggleBtn) {
            toggleBtn.textContent = 'Engine: OFF';
            toggleBtn.style.background = '';
            toggleBtn.style.color = '';
        }
        // Pause compositor videos
        if (state.compositor) state.compositor.pauseVideos();
        console.log('[Compositor] Preview mode DISABLED');
    }
}

/**
 * Load the current video plan into the compositor engine.
 * Builds a synthetic plan from the PROCESSED state (state.scenes + state.motionGraphics)
 * so the compositor sees the exact same data as the timeline preview.
 * Uses getCachedMediaUrl as the URL resolver.
 */
async function loadPlanIntoCompositor() {
    if (!state.compositor || !state.videoPlan) return;

    try {
        // Build a plan from the processed state so compositor matches the timeline exactly.
        // state.videoPlan has the RAW plan; state.scenes has the processed/carved/reordered scenes.
        const compositorPlan = {
            fps: state.videoPlan.fps || 30,
            totalDuration: state.totalDuration || state.videoPlan.totalDuration,
            scriptContext: state.videoPlan.scriptContext || {},
            // Use processed scenes (with corrected endTimes, trackIds, and indices)
            scenes: state.scenes.filter(s => !s.isMGScene).map((s, i) => ({
                ...s,
                // Ensure index is set (use original scene index for media file lookup)
                index: s.index !== undefined ? s.index : i,
            })),
            // Fullscreen MG scenes
            mgScenes: state.scenes.filter(s => s.isMGScene).map(s => ({ ...s })),
            // Overlay motion graphics
            motionGraphics: (state.motionGraphics || []).filter(mg => !mg.disabled),
            // Transitions
            transitions: state.videoPlan.transitions || [],
        };

        await state.compositor.loadPlan(compositorPlan, async (sceneIndex, ext) => {
            return getCachedMediaUrl(sceneIndex, ext);
        });
    } catch (e) {
        console.error('[Compositor] Failed to load plan:', e);
    }
}

/**
 * Run WebGL2 export pipeline.
 * Renders all frames via the engine and pipes to FFmpeg via IPC.
 */
async function renderVideoWebGL2() {
    if (!state.compositor || !state.videoPlan) {
        showToast('Compositor not initialized or no plan loaded', 'error');
        return;
    }

    // Ensure compositor is initialized and plan is loaded
    if (!state.compositor.isInitialized) {
        state.compositor.init();
    }
    await loadPlanIntoCompositor();

    const pipeline = new ExportPipeline(state.compositor);
    pipeline.onProgress((data) => {
        updateProgress(data.percent, `Rendering frame ${data.currentFrame}/${data.totalFrames} (${data.fps} fps)`);
    });

    const result = await pipeline.start({
        width: 1920,
        height: 1080,
        fps: state.videoPlan.fps || 30,
    });

    return result;
}

async function renderVideo() {
    if (!state.videoPlan || state.isProcessing) return;
    state.isProcessing = true; elements.btnRender.disabled = true; showProgress(true); startTimer();
    try {
        // Save current scene state + transition style + SFX into the plan before rendering
        // Separate MG scenes from regular scenes for the renderer
        state.videoPlan.scenes = state.scenes.filter(s => !s.isMGScene).map((s, i) => ({ ...s, index: i }));
        state.videoPlan.mgScenes = state.scenes.filter(s => s.isMGScene && !s.disabled).map(s => ({ ...s }));
        state.videoPlan.totalDuration = state.totalDuration;
        state.videoPlan.transitionStyle = elements.transitionStyle.value;
        // Add SFX data to plan
        generateSfxClips();
        state.videoPlan.sfxEnabled = state.sfxEnabled;
        state.videoPlan.sfxVolume = state.sfxVolume;
        state.videoPlan.sfxClips = state.sfxClips.map(sfx => ({
            file: sfx.file,
            startTime: sfx.startTime,
            duration: sfx.duration,
            volume: sfx.volume
        }));
        // Subtitles flag
        state.videoPlan.subtitlesEnabled = state.subtitlesEnabled;
        // Add motion graphics data to plan
        state.videoPlan.mgEnabled = state.mgEnabled;
        state.videoPlan.mgStyle = state.mgStyle;
        state.videoPlan.motionGraphics = state.motionGraphics.filter(mg => !mg.disabled).map(mg => {
            const base = {
                id: mg.id,
                type: mg.type,
                text: mg.text,
                subtext: mg.subtext || '',
                startTime: mg.startTime,
                duration: mg.duration,
                position: mg.position,
                sceneIndex: mg.sceneIndex,
                style: mg.style || state.mgStyle || 'clean',
                animationSpeed: mg.animationSpeed || undefined,
            };
            // Preserve animatedIcons-specific fields
            if (mg.type === 'animatedIcons') {
                base.icons = mg.icons;
                base.animationStyle = mg.animationStyle;
                base.iconOpacity = mg.iconOpacity;
            }
            // Preserve articleHighlight-specific fields
            if (mg.articleImageFile) base.articleImageFile = mg.articleImageFile;
            if (mg.highlightBoxes) base.highlightBoxes = mg.highlightBoxes;
            return base;
        });
        // Save muted tracks so Composition.jsx can mute audio accordingly
        state.videoPlan.mutedTracks = { ...state.mutedTracks };
        // Global MG animation speed
        const globalAnimSpeed = parseFloat(document.getElementById('mg-global-anim-speed')?.value) || 1.0;
        if (!state.videoPlan.scriptContext) state.videoPlan.scriptContext = {};
        state.videoPlan.scriptContext.mgAnimationSpeed = globalAnimSpeed;
        await window.electronAPI.saveVideoPlan(state.videoPlan);

        const rendererSelect = document.getElementById('renderer-select');
        const rendererValue = rendererSelect ? rendererSelect.value : 'ffmpeg';
        const useFFmpeg = rendererValue === 'ffmpeg';
        const useWebGL2 = rendererValue === 'webgl2';

        if (useWebGL2) {
            updateProgress(5, 'Starting WebGL2 WYSIWYG render...');
        } else {
            updateProgress(5, useFFmpeg ? 'Starting FFmpeg GPU render...' : 'Starting Remotion render...');
        }

        let result;
        if (useWebGL2) {
            result = await renderVideoWebGL2();
        } else if (useFFmpeg) {
            result = await window.electronAPI.runRenderFFmpeg();
        } else {
            result = await window.electronAPI.runRender();
        }
        if (result.success) {
            stopTimer();
            const renderTime = getElapsedString();
            updateProgress(100, `✅ Video rendered! (${renderTime})`);
            showToast(`Video rendered in ${renderTime}!`, 'success');
            showNotification('Render Complete', `Video rendered in ${renderTime}`);
            if (result.outputPath) showFinalVideo(result.outputPath);
        } else {
            stopTimer();
            const errorMsg = result.error || 'Render failed';
            if (errorMsg === 'Cancelled') {
                updateProgress(0, '⛔ Render cancelled');
                showToast('Render cancelled', 'info');
                showNotification('Render Cancelled', `Stopped after ${getElapsedString()}`, 'cancel');
            } else {
                const shortError = errorMsg.length > 100 ? errorMsg.substring(0, 100) + '...' : errorMsg;
                updateProgress(0, `❌ ${errorMsg}`);
                showToast(`Render error: ${shortError}`, 'error');
                showNotification('Render Failed', shortError, 'error');
                console.error('❌ Render error:', errorMsg);
            }
        }
    } catch (e) {
        stopTimer();
        console.error('❌ Render error:', e);
        const errMsg = e.message.length > 100 ? e.message.substring(0, 100) + '...' : e.message;
        showToast(`Render error: ${errMsg}`, 'error');
        showNotification('Render Failed', errMsg, 'error');
        updateProgress(0, `❌ ${e.message}`);
    } finally {
        state.isProcessing = false;
        elements.btnRender.disabled = false;
        elements.btnCancel.disabled = false;
        elements.btnCancel.textContent = 'Cancel';
        setTimeout(() => showProgress(false), 5000);
    }
}

async function showFinalVideo(videoPath) {
    try {
        // Stop any existing playback
        stopPlayback();
        cleanupVideoHandlers();

        const url = await window.electronAPI.getFileUrl(videoPath);
        if (url) {
            elements.previewPlaceholder.classList.add('hidden');
            elements.previewVideo.classList.remove('hidden');
            elements.previewVideo.src = url;
            elements.previewVideo.play();
        }
        showToast('Video rendered!', 'success');
    } catch (e) {
        console.error('Failed to show final video:', e);
    }
}

// ========================================
// UI Helpers
// ========================================
function showProgress(show) { elements.progressContainer.classList.toggle('hidden', !show); if (!show) stopTimer(); }
function updateProgress(percent, message) { elements.progressFill.style.width = `${percent}%`; elements.progressText.textContent = message; }

// Build / Render timer
let _timerInterval = null;
let _timerStart = 0;
function startTimer() {
    stopTimer();
    _timerStart = Date.now();
    updateTimerDisplay();
    _timerInterval = setInterval(updateTimerDisplay, 1000);
}
function stopTimer() {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
}
function updateTimerDisplay() {
    const elapsed = Math.floor((Date.now() - _timerStart) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    parts.push(`${String(m).padStart(2, '0')}m`);
    parts.push(`${String(s).padStart(2, '0')}s`);
    if (elements.progressTimer) elements.progressTimer.textContent = parts.join(' ');
}
function getElapsedString() {
    const elapsed = Math.floor((Date.now() - _timerStart) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0 || h > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
}
// ========================================
// Notification Center (persisted, 3-day max)
// ========================================
const NOTIF_STORAGE_KEY = 'faceless_notifications';
const NOTIF_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

function loadNotifications() {
    try {
        const raw = localStorage.getItem(NOTIF_STORAGE_KEY);
        if (!raw) return [];
        const items = JSON.parse(raw);
        const cutoff = Date.now() - NOTIF_MAX_AGE_MS;
        return items.filter(n => n.timestamp > cutoff);
    } catch { return []; }
}

function saveNotifications(items) {
    localStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(items));
}

function addNotification(title, body, type = 'success') {
    const items = loadNotifications();
    items.unshift({ title, body, type, timestamp: Date.now(), read: false });
    // Keep max 50 entries
    if (items.length > 50) items.length = 50;
    saveNotifications(items);
    renderNotifList();
    updateNotifBadge();
}

function renderNotifList() {
    const list = document.getElementById('notif-list');
    if (!list) return;
    const items = loadNotifications();
    if (items.length === 0) {
        list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
        return;
    }
    list.innerHTML = items.map((n, i) => `
        <div class="notif-item ${n.read ? '' : 'unread'}" data-notif-index="${i}">
            <div class="notif-dot ${n.type}"></div>
            <div class="notif-body">
                <div class="notif-title">${n.title}</div>
                <div class="notif-desc">${n.body}</div>
            </div>
            <div class="notif-time">${formatNotifTime(n.timestamp)}</div>
        </div>
    `).join('');
}

function updateNotifBadge() {
    const badge = document.getElementById('notif-badge');
    if (!badge) return;
    const unread = loadNotifications().filter(n => !n.read).length;
    badge.textContent = unread;
    badge.classList.toggle('hidden', unread === 0);
}

function markAllRead() {
    const items = loadNotifications();
    items.forEach(n => n.read = true);
    saveNotifications(items);
    updateNotifBadge();
    renderNotifList();
}

function clearAllNotifications() {
    saveNotifications([]);
    renderNotifList();
    updateNotifBadge();
}

function formatNotifTime(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function setupNotifCenter() {
    const bell = document.getElementById('notif-bell');
    const dropdown = document.getElementById('notif-dropdown');
    const clearBtn = document.getElementById('notif-clear');
    if (!bell || !dropdown) return;

    bell.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = !dropdown.classList.contains('hidden');
        if (isOpen) {
            dropdown.classList.add('hidden');
        } else {
            dropdown.classList.remove('hidden');
            markAllRead();
        }
    });

    clearBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        clearAllNotifications();
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.notif-center')) {
            dropdown.classList.add('hidden');
        }
    });

    // Initial render
    renderNotifList();
    updateNotifBadge();
}

function showNotification(title, body, type = 'success') {
    // Store in notification center
    addNotification(title, body, type);

    // OS-level notification
    if (window.electronAPI?.showNotification) {
        window.electronAPI.showNotification(title, body);
    } else if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body });
    } else if ('Notification' in window && Notification.permission !== 'denied') {
        Notification.requestPermission().then(p => { if (p === 'granted') new Notification(title, { body }); });
    }
    // Also show a persistent banner in-app
    const isCancelled = type === 'cancel';
    const icon = isCancelled ? '&#10007;' : '&#10003;';
    document.querySelector('.completion-banner')?.remove();
    const banner = document.createElement('div');
    banner.className = `completion-banner ${isCancelled ? 'banner-cancel' : ''}`;
    banner.innerHTML = `<span class="completion-icon">${icon}</span><div class="completion-text"><strong>${title}</strong><span>${body}</span></div><button class="completion-close">&times;</button>`;
    document.body.appendChild(banner);
    setTimeout(() => banner.classList.add('show'), 10);
    banner.querySelector('.completion-close').addEventListener('click', () => {
        banner.classList.remove('show');
        setTimeout(() => banner.remove(), 300);
    });
    // Auto-dismiss after 30s
    setTimeout(() => { if (banner.parentNode) { banner.classList.remove('show'); setTimeout(() => banner.remove(), 300); } }, 30000);
}
function showToast(message, type = 'info') {
    document.querySelector('.toast')?.remove();
    const toast = document.createElement('div'); toast.className = `toast ${type}`; toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3000);
}
function formatTime(s) { return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`; }

function clearScenes() {
    // Stop playback and clean up
    stopPlayback();
    cleanupVideoHandlers();

    // Reset state
    state.scenes = [];
    state.videoPlan = null;
    state.currentSceneIndex = 0;
    state.currentTime = 0;
    state.totalDuration = 0;
    state.isPlaying = false;
    state.playbackAnimationFrame = null;
    state.transition.isTransitioning = false;
    state.transition.activeVideoIndex = 0;

    // Clear UI
    elements.sceneList.innerHTML = '<p class="empty-state">No scenes yet</p>';
    elements.timelineContainer.innerHTML = '<div class="timeline-header"><span>Timeline</span><span>0:00</span></div><div class="timeline-empty">Import audio to see timeline</div>';

    // Reset video elements using helper
    if (elements.previewVideo) {
        elements.previewVideo.pause();
        elements.previewVideo.currentTime = 0;
        elements.previewVideo.src = '';
        resetVideoTransitionState(elements.previewVideo);
    }
    if (elements.previewVideoNext) {
        elements.previewVideoNext.pause();
        elements.previewVideoNext.currentTime = 0;
        elements.previewVideoNext.src = '';
        resetVideoTransitionState(elements.previewVideoNext);
    }

    // Hide video container, show placeholder
    if (elements.videoContainer) {
        elements.videoContainer.classList.add('hidden');
        elements.videoContainer.className = 'video-transition-container hidden';
    }
    if (elements.videoControls) {
        elements.videoControls.classList.add('hidden');
    }
    elements.previewPlaceholder.classList.remove('hidden');

    // Reset audio element
    if (elements.previewAudio) {
        elements.previewAudio.pause();
        elements.previewAudio.currentTime = 0;
    }
}

function saveSettings() {
    localStorage.setItem('faceless-settings', JSON.stringify({
        aiProvider: elements.aiProvider.value,
        ollamaModel: elements.ollamaModel?.value || 'gemma3:12b',
        ollamaVisionModel: elements.ollamaVisionModel?.value || 'llava',
        transitionStyle: elements.transitionStyle.value,
        transitionDuration: state.transition.duration,
        volume: state.volume,
        footageSources: getEnabledSources(),
        sfxEnabled: state.sfxEnabled,
        sfxVolume: state.sfxVolume,
        mgEnabled: state.mgEnabled,
        subtitlesEnabled: state.subtitlesEnabled,
        aiInstructions: state.aiInstructions,
        mutedTracks: state.mutedTracks
    }));
    // Also trigger .fvp auto-save so settings persist per-project
    triggerAutoSave();
}

function getEnabledSources() {
    return {
        pexels: elements.srcPexels?.checked ?? true,
        pixabay: elements.srcPixabay?.checked ?? true,
        youtube: elements.srcYouTube?.checked ?? false,
        newsVideo: elements.srcNewsVideo?.checked ?? false,
        unsplash: elements.srcUnsplash?.checked ?? true,
        googleCSE: elements.srcGoogleCSE?.checked ?? false,
        bing: elements.srcBing?.checked ?? false,
        duckduckgo: elements.srcDuckDuckGo?.checked ?? true,
        googleScrape: elements.srcGoogleScrape?.checked ?? true,
    };
}

function loadSettings() {
    try {
        const s = JSON.parse(localStorage.getItem('faceless-settings'));
        if (s) {
            elements.aiProvider.value = s.aiProvider || 'ollama';
            // Restore Ollama model selections
            if (elements.ollamaModel) elements.ollamaModel.value = s.ollamaModel || 'gemma3:12b';
            if (elements.ollamaVisionModel) elements.ollamaVisionModel.value = s.ollamaVisionModel || 'llava';
            if (elements.ollamaModelRow) {
                elements.ollamaModelRow.style.display = (s.aiProvider || 'ollama') === 'ollama' ? 'block' : 'none';
            }
            // Transitions disabled - always hard cut
            state.transition.style = 'cut';
            state.transition.duration = 0;
            state.volume = s.volume !== undefined ? s.volume : 1;
            if (elements.volumeSlider) {
                elements.volumeSlider.value = state.volume;
            }
            // Restore SFX settings
            state.sfxEnabled = s.sfxEnabled !== undefined ? s.sfxEnabled : true;
            state.sfxVolume = s.sfxVolume !== undefined ? s.sfxVolume : 0.35;
            if (elements.sfxEnabled) elements.sfxEnabled.checked = state.sfxEnabled;
            if (elements.sfxVolume) elements.sfxVolume.value = state.sfxVolume;
            if (elements.sfxVolumeLabel) elements.sfxVolumeLabel.textContent = `${Math.round(state.sfxVolume * 100)}%`;
            // Restore Motion Graphics settings
            state.mgEnabled = s.mgEnabled !== undefined ? s.mgEnabled : true;
            if (elements.mgEnabled) elements.mgEnabled.checked = state.mgEnabled;
            // Restore Subtitles setting
            state.subtitlesEnabled = s.subtitlesEnabled !== undefined ? s.subtitlesEnabled : false;
            if (elements.subtitlesEnabled) elements.subtitlesEnabled.checked = state.subtitlesEnabled;
            // Restore AI Instructions
            state.aiInstructions = s.aiInstructions || '';
            if (elements.aiInstructions) elements.aiInstructions.value = state.aiInstructions;
            // Restore track mute state
            if (s.mutedTracks) state.mutedTracks = s.mutedTracks;
            // Restore footage source toggles
            if (s.footageSources) {
                if (elements.srcPexels) elements.srcPexels.checked = s.footageSources.pexels ?? true;
                if (elements.srcPixabay) elements.srcPixabay.checked = s.footageSources.pixabay ?? true;
                if (elements.srcYouTube) elements.srcYouTube.checked = s.footageSources.youtube ?? false;
                if (elements.srcNewsVideo) elements.srcNewsVideo.checked = s.footageSources.newsVideo ?? false;
                if (elements.srcUnsplash) elements.srcUnsplash.checked = s.footageSources.unsplash ?? true;
                if (elements.srcGoogleCSE) elements.srcGoogleCSE.checked = s.footageSources.googleCSE ?? false;
                if (elements.srcBing) elements.srcBing.checked = s.footageSources.bing ?? false;
                if (elements.srcDuckDuckGo) elements.srcDuckDuckGo.checked = s.footageSources.duckduckgo ?? true;
                if (elements.srcGoogleScrape) elements.srcGoogleScrape.checked = s.footageSources.googleScrape ?? true;
            }
        }
    } catch (e) { }
}

// Apply settings from .fvp project file (same logic as loadSettings but from object, not localStorage)
function applyProjectSettings(s) {
    if (!s) return;
    try {
        elements.aiProvider.value = s.aiProvider || 'ollama';
        if (elements.ollamaModel) elements.ollamaModel.value = s.ollamaModel || 'gemma3:12b';
        if (elements.ollamaVisionModel) elements.ollamaVisionModel.value = s.ollamaVisionModel || 'llava';
        if (elements.ollamaModelRow) {
            elements.ollamaModelRow.style.display = (s.aiProvider || 'ollama') === 'ollama' ? 'block' : 'none';
        }
        // Transitions disabled - always hard cut
        state.transition.style = 'cut';
        state.transition.duration = 0;
        state.volume = s.volume !== undefined ? s.volume : 1;
        if (elements.volumeSlider) elements.volumeSlider.value = state.volume;
        // SFX
        state.sfxEnabled = s.sfxEnabled !== undefined ? s.sfxEnabled : true;
        state.sfxVolume = s.sfxVolume !== undefined ? s.sfxVolume : 0.35;
        if (elements.sfxEnabled) elements.sfxEnabled.checked = state.sfxEnabled;
        if (elements.sfxVolume) elements.sfxVolume.value = state.sfxVolume;
        if (elements.sfxVolumeLabel) elements.sfxVolumeLabel.textContent = `${Math.round(state.sfxVolume * 100)}%`;
        // MG
        state.mgEnabled = s.mgEnabled !== undefined ? s.mgEnabled : true;
        if (elements.mgEnabled) elements.mgEnabled.checked = state.mgEnabled;
        // Subtitles
        state.subtitlesEnabled = s.subtitlesEnabled !== undefined ? s.subtitlesEnabled : false;
        if (elements.subtitlesEnabled) elements.subtitlesEnabled.checked = state.subtitlesEnabled;
        // AI Instructions
        state.aiInstructions = s.aiInstructions || '';
        if (elements.aiInstructions) elements.aiInstructions.value = state.aiInstructions;
        // Track mute
        if (s.mutedTracks) state.mutedTracks = s.mutedTracks;
        // Footage sources
        if (s.footageSources) {
            if (elements.srcPexels) elements.srcPexels.checked = s.footageSources.pexels ?? true;
            if (elements.srcPixabay) elements.srcPixabay.checked = s.footageSources.pixabay ?? true;
            if (elements.srcYouTube) elements.srcYouTube.checked = s.footageSources.youtube ?? false;
            if (elements.srcNewsVideo) elements.srcNewsVideo.checked = s.footageSources.newsVideo ?? false;
            if (elements.srcUnsplash) elements.srcUnsplash.checked = s.footageSources.unsplash ?? true;
            if (elements.srcGoogleCSE) elements.srcGoogleCSE.checked = s.footageSources.googleCSE ?? false;
            if (elements.srcBing) elements.srcBing.checked = s.footageSources.bing ?? false;
            if (elements.srcDuckDuckGo) elements.srcDuckDuckGo.checked = s.footageSources.duckduckgo ?? true;
            if (elements.srcGoogleScrape) elements.srcGoogleScrape.checked = s.footageSources.googleScrape ?? true;
        }
        console.log('✅ Applied project settings from .fvp file');
    } catch (e) {
        console.warn('Could not apply project settings:', e);
    }
}

async function loadProjectInfo() {
    try {
        if (!window.electronAPI.getProjectInfo) return;
        const info = await window.electronAPI.getProjectInfo();
        if (info && info.projectName && elements.projectNameLabel) {
            elements.projectNameLabel.textContent = `— ${info.projectName}`;
            elements.projectNameLabel.title = `Project: ${info.projectDir}\nClick to open folder`;
            elements.projectNameLabel.style.cursor = 'pointer';
            elements.projectNameLabel.onclick = () => {
                if (info.projectDir && window.electronAPI.openFile) {
                    window.electronAPI.openFile(info.projectDir);
                }
            };
        }
    } catch (e) {
        console.warn('Could not load project info:', e);
    }
}

async function newProject() {
    if (state.isProcessing) {
        showToast('Please wait for current process to finish', 'error');
        return;
    }

    if (window.electronAPI.launchNewInstance) {
        showNewProjectDialog();
        return;
    }

    // Fallback: reset current project (no multi-instance support)
    resetCurrentProject();
}

function showNewProjectDialog() {
    // Remove existing dialog if any
    const existing = document.getElementById('new-project-dialog');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'new-project-dialog';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:#1e1e2e;border:1px solid #444;border-radius:12px;padding:28px 32px;width:480px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,0.5);';
    dialog.innerHTML = `
        <h2 style="margin:0 0 20px;font-size:1.2rem;color:#e0e0e0;font-weight:600;">New Project</h2>
        <div style="margin-bottom:16px;">
            <label style="display:block;margin-bottom:6px;font-size:0.85rem;color:#aaa;">Project Name</label>
            <input id="np-name" type="text" placeholder="My Video Project" value="Untitled Project"
                   style="width:100%;padding:10px 12px;background:#12121a;border:1px solid #555;border-radius:6px;color:#fff;font-size:0.95rem;outline:none;box-sizing:border-box;"
                   onfocus="this.select()" />
        </div>
        <div style="margin-bottom:20px;">
            <label style="display:block;margin-bottom:6px;font-size:0.85rem;color:#aaa;">Location</label>
            <div style="display:flex;gap:8px;">
                <input id="np-location" type="text" readonly placeholder="Choose a folder..."
                       style="flex:1;padding:10px 12px;background:#12121a;border:1px solid #555;border-radius:6px;color:#ccc;font-size:0.85rem;outline:none;cursor:pointer;box-sizing:border-box;" />
                <button id="np-browse" style="padding:10px 16px;background:#333;border:1px solid #555;border-radius:6px;color:#fff;cursor:pointer;font-size:0.85rem;white-space:nowrap;">Browse...</button>
            </div>
        </div>
        <div id="np-preview" style="margin-bottom:20px;padding:10px 12px;background:#12121a;border-radius:6px;font-size:0.8rem;color:#666;font-family:monospace;"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
            <button id="np-cancel" style="padding:10px 20px;background:transparent;border:1px solid #555;border-radius:6px;color:#aaa;cursor:pointer;font-size:0.9rem;">Cancel</button>
            <button id="np-create" style="padding:10px 24px;background:#4a6cf7;border:none;border-radius:6px;color:#fff;cursor:pointer;font-size:0.9rem;font-weight:600;" disabled>Create Project</button>
        </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const nameInput = document.getElementById('np-name');
    const locationInput = document.getElementById('np-location');
    const browseBtn = document.getElementById('np-browse');
    const previewEl = document.getElementById('np-preview');
    const createBtn = document.getElementById('np-create');
    const cancelBtn = document.getElementById('np-cancel');

    let selectedLocation = '';

    function updatePreview() {
        const name = nameInput.value.trim();
        if (name && selectedLocation) {
            previewEl.style.color = '#888';
            previewEl.textContent = selectedLocation + '\\' + name + '\\';
            createBtn.disabled = false;
        } else {
            previewEl.style.color = '#666';
            previewEl.textContent = name ? 'Choose a location...' : '';
            createBtn.disabled = true;
        }
    }

    nameInput.addEventListener('input', updatePreview);
    nameInput.focus();

    browseBtn.addEventListener('click', async () => {
        const folder = await window.electronAPI.selectFolder('Choose project location');
        if (folder) {
            selectedLocation = folder;
            locationInput.value = folder;
            updatePreview();
        }
    });

    locationInput.addEventListener('click', () => browseBtn.click());

    cancelBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    createBtn.addEventListener('click', async () => {
        const projectName = nameInput.value.trim();
        if (!projectName || !selectedLocation) return;

        createBtn.disabled = true;
        createBtn.textContent = 'Creating...';

        const result = await window.electronAPI.launchNewInstance({
            projectName: projectName,
            location: selectedLocation
        });

        if (result && result.success) {
            showToast(`Project "${projectName}" created`, 'success');
            overlay.remove();
        } else {
            showToast('Failed to create project', 'error');
            createBtn.disabled = false;
            createBtn.textContent = 'Create Project';
        }
    });

    // Enter key to create
    nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !createBtn.disabled) createBtn.click();
        if (e.key === 'Escape') overlay.remove();
    });
}

function resetCurrentProject() {
    if (state.audioFile && !confirm('Reset current project? This clears the current work.')) return;

    stopPlayback();
    cleanupVideoHandlers();
    removeAudio();

    state.selectedClipIndex = -1;
    state.selectedClipIndices = [];

    [elements.videoTrack1, elements.videoTrack2, elements.videoTrack3,
     elements.videoTrack1B, elements.videoTrack2B, elements.videoTrack3B].forEach(video => {
        if (video) {
            video.pause();
            video.currentTime = 0;
            video.src = '';
            video._loadedUrl = null;
            video.classList.remove('active');
        }
    });
    state._trackActiveEl = { '1': 'a', '2': 'a', '3': 'a' };
    [elements.imgTrack1, elements.imgTrack2, elements.imgTrack3].forEach(img => {
        if (img) {
            img.src = '';
            img.classList.remove('active');
        }
    });

    elements.previewPlaceholder.classList.remove('hidden');
    elements.btnRender.disabled = true;
    showProgress(false);
    showToast('New project started', 'success');
}

function showOpenProjectDialog() {
    const existing = document.getElementById('open-project-dialog');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'open-project-dialog';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:#1e1e2e;border:1px solid #444;border-radius:12px;padding:24px 28px;width:460px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,0.5);';
    dialog.innerHTML = `
        <h2 style="margin:0 0 10px;font-size:1.2rem;color:#e0e0e0;font-weight:600;">Open Project</h2>
        <p style="margin:0 0 18px;color:#aaa;line-height:1.45;">Choose how you want to open your project.</p>
        <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:12px;">
            <button id="op-open-folder" style="padding:11px 14px;background:#2e3a70;border:1px solid #5b6bd8;border-radius:8px;color:#fff;cursor:pointer;font-size:0.95rem;font-weight:600;text-align:left;">Open Project Folder</button>
            <button id="op-open-file" style="padding:11px 14px;background:#2a2f3f;border:1px solid #555;border-radius:8px;color:#fff;cursor:pointer;font-size:0.95rem;font-weight:600;text-align:left;">Open .fvp Project File</button>
        </div>
        <div id="op-status" style="min-height:18px;margin-bottom:12px;color:#888;font-size:0.85rem;"></div>
        <div style="display:flex;justify-content:flex-end;">
            <button id="op-cancel" style="padding:9px 16px;background:transparent;border:1px solid #555;border-radius:6px;color:#aaa;cursor:pointer;font-size:0.9rem;">Cancel</button>
        </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const openFolderBtn = document.getElementById('op-open-folder');
    const openFileBtn = document.getElementById('op-open-file');
    const cancelBtn = document.getElementById('op-cancel');
    const statusEl = document.getElementById('op-status');

    const setBusy = (busy, text = '') => {
        openFolderBtn.disabled = busy;
        openFileBtn.disabled = busy;
        cancelBtn.disabled = busy;
        openFolderBtn.style.opacity = busy ? '0.6' : '1';
        openFileBtn.style.opacity = busy ? '0.6' : '1';
        statusEl.textContent = text;
    };

    const runOpen = async (kind) => {
        const openFolder = window.electronAPI.openExistingProjectFolder;
        const openFile = window.electronAPI.openExistingProjectFile;
        if (!openFolder || !openFile) {
            statusEl.style.color = '#ff8f8f';
            statusEl.textContent = 'Open project APIs are unavailable.';
            return;
        }
        setBusy(true, kind === 'folder' ? 'Selecting folder...' : 'Selecting .fvp file...');
        try {
            const result = kind === 'folder' ? await openFolder() : await openFile();
            if (result && result.success) {
                showToast('Project window opened', 'success');
                overlay.remove();
                return;
            }
            setBusy(false, '');
            if (result && result.cancelled) return;
            statusEl.style.color = '#ff8f8f';
            statusEl.textContent = result?.error || 'Failed to open project.';
        } catch (e) {
            setBusy(false, '');
            statusEl.style.color = '#ff8f8f';
            statusEl.textContent = e?.message || 'Failed to open project.';
        }
    };

    openFolderBtn.addEventListener('click', () => runOpen('folder'));
    openFileBtn.addEventListener('click', () => runOpen('file'));
    cancelBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.getElementById('open-project-dialog')) {
            overlay.remove();
        }
    }, { once: true });
}

async function openExistingProject() {
    if (state.isProcessing) {
        showToast('Please wait for current process to finish', 'error');
        return;
    }

    // Prefer custom in-app chooser dialog (no native mode prompt popup)
    if (window.electronAPI.openExistingProjectFolder && window.electronAPI.openExistingProjectFile) {
        showOpenProjectDialog();
        return;
    }

    // Backward compatibility fallback
    if (window.electronAPI.openExistingProject) {
        const result = await window.electronAPI.openExistingProject();
        if (result && result.success) {
            showToast('Project window opened', 'success');
        }
    }
}

function refreshApp() {
    if (state.isProcessing) {
        showToast('Please wait for current process to finish', 'error');
        return;
    }
    showToast('Refreshing...', 'info');
    // Reload the window - picks up any file changes without restarting the server
    window.location.reload();
}

// ========================================
// Electron API Fallback
// ========================================
if (!window.electronAPI) {
    window.electronAPI = {
        runBuild: async () => ({ success: true }), runRender: async () => ({ success: true, outputPath: '' }),
        loadVideoPlan: async () => ({
            totalDuration: 30, scenes: [
                { text: 'Welcome to this video...', keyword: 'city skyline', startTime: 0, endTime: 5 },
                { text: 'Today we will discuss...', keyword: 'business meeting', startTime: 5, endTime: 12 },
                { text: 'The most important thing...', keyword: 'success', startTime: 12, endTime: 20 },
                { text: 'Thank you for watching!', keyword: 'sunset ocean', startTime: 20, endTime: 30 }
            ]
        }),
        copyFile: async () => true, getSceneVideoPath: async () => null, getSceneMediaPath: async () => null, getFileUrl: async () => null, getAudioPath: async () => null,
        openExistingProject: async () => ({ success: false, cancelled: true }),
        openExistingProjectFolder: async () => ({ success: false, cancelled: true }),
        openExistingProjectFile: async () => ({ success: false, cancelled: true }),
        onBuildProgress: () => { }, onRenderProgress: () => { },
        cancelProcess: async () => ({ success: true, message: 'Cancelled' }),
        showNotification: () => { }
    };
}

document.addEventListener('DOMContentLoaded', init);
