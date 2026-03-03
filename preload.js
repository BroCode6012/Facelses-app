/**
 * YTA Empire 2 - Electron Preload Script
 * This safely exposes Electron APIs to the renderer (UI)
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
    // Copy file to project folder
    copyFile: (sourcePath, destFolder) => {
        return ipcRenderer.invoke('copy-file', sourcePath, destFolder);
    },

    // Run the build pipeline
    runBuild: (options) => {
        return ipcRenderer.invoke('run-build', options);
    },

    // Load video plan
    loadVideoPlan: () => {
        return ipcRenderer.invoke('load-video-plan');
    },

    // Save video plan
    saveVideoPlan: (plan) => {
        return ipcRenderer.invoke('save-video-plan', plan);
    },

    // Get scene video path (backward compat)
    getSceneVideoPath: (sceneIndex) => {
        return ipcRenderer.invoke('get-scene-video-path', sceneIndex);
    },

    // Get scene media path (video or image, with extension hint and optional prefix)
    getSceneMediaPath: (sceneIndex, extension, prefix) => {
        return ipcRenderer.invoke('get-scene-media-path', sceneIndex, extension, prefix);
    },

    // Get audio path
    getAudioPath: (filename) => {
        return ipcRenderer.invoke('get-audio-path', filename);
    },

    // Get file URL for video playback
    getFileUrl: (filePath) => {
        return ipcRenderer.invoke('get-file-url', filePath);
    },

    // Render video with Remotion
    runRender: () => {
        return ipcRenderer.invoke('run-render');
    },

    // Render video with FFmpeg (GPU-accelerated)
    runRenderFFmpeg: () => {
        return ipcRenderer.invoke('run-render-ffmpeg');
    },

    // Open output folder
    openOutputFolder: () => {
        return ipcRenderer.invoke('open-output-folder');
    },

    // Open current project logs folder
    openProjectLogs: () => {
        return ipcRenderer.invoke('open-project-logs');
    },

    // Open live tail window for current project log
    tailProjectLogs: () => {
        return ipcRenderer.invoke('tail-project-logs');
    },

    // Get current log file path
    getCurrentLogFile: () => {
        return ipcRenderer.invoke('get-current-log-file');
    },

    // Open file in default app
    openFile: (filePath) => {
        return ipcRenderer.invoke('open-file', filePath);
    },

    // File dialog
    selectFile: (options) => {
        return ipcRenderer.invoke('select-file', options);
    },

    // Folder dialog
    selectFolder: (title) => {
        return ipcRenderer.invoke('select-folder', title);
    },

    // Listen for progress updates
    onBuildProgress: (callback) => {
        ipcRenderer.on('build-progress', (event, data) => callback(data));
    },

    onRenderProgress: (callback) => {
        ipcRenderer.on('render-progress', (event, data) => callback(data));
    },

    // Menu commands from main process
    onMenuUndo: (callback) => { ipcRenderer.on('menu-undo', () => callback()); },
    onMenuCopy: (callback) => { ipcRenderer.on('menu-copy', () => callback()); },
    onMenuPaste: (callback) => { ipcRenderer.on('menu-paste', () => callback()); },
    onMenuSave: (callback) => { ipcRenderer.on('menu-save', () => callback()); },
    onMenuDelete: (callback) => { ipcRenderer.on('menu-delete', () => callback()); },
    onMenuSelectAll: (callback) => { ipcRenderer.on('menu-select-all', () => callback()); },
    onMenuNew: (callback) => { ipcRenderer.on('menu-new', () => callback()); },

    // Show OS notification
    showNotification: (title, body) => {
        ipcRenderer.invoke('show-notification', title, body);
    },

    // Cancel active build/render process
    cancelProcess: () => {
        return ipcRenderer.invoke('cancel-process');
    },

    // Get SFX file path for preview playback
    getSfxPath: (filename) => {
        return ipcRenderer.invoke('get-sfx-path', filename);
    },

    // Scan assets/overlays/ folder for available overlay files
    scanOverlays: () => {
        return ipcRenderer.invoke('scan-overlays');
    },

    // Get overlay file URL for preview playback
    getOverlayUrl: (filename) => {
        return ipcRenderer.invoke('get-overlay-url', filename);
    },

    // Scan assets/backgrounds/ folder for available background pattern files
    scanBackgrounds: () => {
        return ipcRenderer.invoke('scan-backgrounds');
    },

    // Get background file URL for preview
    getBackgroundUrl: (filename) => {
        return ipcRenderer.invoke('get-background-url', filename);
    },

    // Get filesystem path from a File object (required for sandboxed Electron 20+)
    getFilePath: (file) => webUtils.getPathForFile(file),

    // Desktop shortcut
    createDesktopShortcut: () => ipcRenderer.invoke('create-desktop-shortcut'),

    // Multi-instance / project management
    getProjectInfo: () => ipcRenderer.invoke('get-project-info'),
    launchNewInstance: (options) => ipcRenderer.invoke('launch-new-instance', options),
    openExistingProject: () => ipcRenderer.invoke('open-existing-project'),
    openExistingProjectFolder: () => ipcRenderer.invoke('open-existing-project-folder'),
    openExistingProjectFile: () => ipcRenderer.invoke('open-existing-project-file'),
    startupCreateProject: () => ipcRenderer.invoke('startup-create-project'),
    startupOpenProjectFolder: () => ipcRenderer.invoke('startup-open-project-folder'),
    startupOpenProjectFile: () => ipcRenderer.invoke('startup-open-project-file'),
    startupCancel: () => ipcRenderer.invoke('startup-cancel'),

    // Register .fvp file association with Windows
    registerFvpAssociation: () => ipcRenderer.invoke('register-fvp-association'),

    // Project file (.fvp) save/load
    saveProjectFile: (data) => ipcRenderer.invoke('save-project-file', data),
    loadProjectFile: () => ipcRenderer.invoke('load-project-file'),
    getRecentProjects: () => ipcRenderer.invoke('get-recent-projects'),
    addRecentProject: () => ipcRenderer.invoke('add-recent-project'),

    // ========================================
    // WebGL2 Compositor Engine - Export IPC
    // ========================================

    // Start WebGL2 export (spawns FFmpeg with raw RGBA pipe)
    startWebGLExport: (options) => {
        return ipcRenderer.invoke('start-webgl-export', options);
    },

    // Send a single raw RGBA frame buffer to FFmpeg
    sendExportFrame: (frameBuffer) => {
        return ipcRenderer.invoke('export-frame', frameBuffer);
    },

    // Finish export (close FFmpeg stdin, mux audio, return output path)
    finishWebGLExport: () => {
        return ipcRenderer.invoke('finish-webgl-export');
    },

    // Cancel an in-progress WebGL2 export
    cancelWebGLExport: () => {
        return ipcRenderer.invoke('cancel-webgl-export');
    },

    // Remove listeners (cleanup)
    removeAllListeners: (channel) => {
        ipcRenderer.removeAllListeners(channel);
    }
});

console.log('✅ Electron preload script loaded');
