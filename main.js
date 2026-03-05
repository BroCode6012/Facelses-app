/**
 * YTA Empire 2 - Electron Main Process
 * This file creates the desktop app window and bridges the UI to Node.js
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync, spawn, exec } = require('child_process');

// ========================================
// Project Directory Resolution
// ========================================
// Parse --project=<path> or .fvp file path from command line args
const APP_ROOT = __dirname;  // The app's install directory (code, node_modules, assets)
let PROJECT_DIR = APP_ROOT;  // Default: use app root (backward compat)
let hasExplicitProject = false;

for (const arg of process.argv) {
    if (arg.startsWith('--project=')) {
        PROJECT_DIR = arg.substring('--project='.length);
        hasExplicitProject = true;
        break;
    }
    // Handle double-click on .fvp file: extract project dir from file path
    if (arg.endsWith('.fvp') && fs.existsSync(arg)) {
        PROJECT_DIR = path.dirname(arg);
        hasExplicitProject = true;
        break;
    }
}

// Resolve to absolute path
PROJECT_DIR = path.resolve(PROJECT_DIR);

// ========================================
// Single-Instance Lock (per project directory)
// ========================================
// Each unique PROJECT_DIR gets its own lock so multiple projects can run simultaneously,
// but two instances can't accidentally share the same project folder.
// We use a lock file instead of Electron's requestSingleInstanceLock because that's app-global.
function acquireProjectLock() {
    const lockFile = path.join(PROJECT_DIR, '.lock');
    try {
        // Ensure directory exists before creating lock
        if (!fs.existsSync(PROJECT_DIR)) {
            fs.mkdirSync(PROJECT_DIR, { recursive: true });
        }
        // Try to create lock file exclusively (fails if already exists)
        fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
        return true;
    } catch (e) {
        if (e.code === 'EEXIST') {
            // Lock file exists — check if the PID is still alive
            try {
                const pid = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
                if (pid && !isNaN(pid)) {
                    // Check if process is still running
                    try {
                        process.kill(pid, 0); // signal 0 = just check if alive
                        return false; // Process is alive — lock is held
                    } catch (_) {
                        // Process is dead — stale lock, overwrite it
                        fs.writeFileSync(lockFile, String(process.pid));
                        return true;
                    }
                }
            } catch (_) {}
            // Can't read lock file or invalid PID — overwrite
            fs.writeFileSync(lockFile, String(process.pid));
            return true;
        }
        // Some other error (e.g. dir doesn't exist yet) — proceed anyway
        return true;
    }
}

function releaseProjectLock() {
    try {
        const lockFile = path.join(PROJECT_DIR, '.lock');
        if (fs.existsSync(lockFile)) {
            const pid = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
            if (pid === process.pid) {
                fs.unlinkSync(lockFile);
            }
        }
    } catch (_) {}
}

// Project-specific paths (isolated per instance)
const PROJECT_ROOT = APP_ROOT; // Keep for code/node_modules references
let INPUT_PATH = path.join(PROJECT_DIR, 'input');
let OUTPUT_PATH = path.join(PROJECT_DIR, 'output');
let TEMP_PATH = path.join(PROJECT_DIR, 'temp');
let PUBLIC_PATH = path.join(PROJECT_DIR, 'public');

// Ensure project subdirectories exist
function ensureProjectDirs() {
    for (const dir of [INPUT_PATH, OUTPUT_PATH, TEMP_PATH, PUBLIC_PATH]) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}
ensureProjectDirs();

// Copy .env from app root to project dir if it doesn't exist there yet
const appEnvPath = path.join(APP_ROOT, '.env');
const projectEnvPath = path.join(PROJECT_DIR, '.env');
if (PROJECT_DIR !== APP_ROOT && fs.existsSync(appEnvPath) && !fs.existsSync(projectEnvPath)) {
    fs.copyFileSync(appEnvPath, projectEnvPath);
}

// Derive a human-readable project name from the directory
let PROJECT_NAME = PROJECT_DIR === APP_ROOT ? '' : path.basename(PROJECT_DIR);
let CURRENT_LOG_FILE = null;

const _baseConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
};

function getLogsDir(projectDir = PROJECT_DIR) {
    return path.join(projectDir, 'logs');
}

function ensureLogsDir(projectDir = PROJECT_DIR) {
    const logsDir = getLogsDir(projectDir);
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }
    return logsDir;
}

function nowStamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function stringifyLogArgs(args) {
    return args.map((a) => {
        if (typeof a === 'string') return a;
        try {
            return JSON.stringify(a);
        } catch {
            return String(a);
        }
    }).join(' ');
}

function appendProjectLog(level, message) {
    if (!CURRENT_LOG_FILE) return;
    try {
        const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
        fs.appendFileSync(CURRENT_LOG_FILE, line, 'utf8');
    } catch (e) {
        _baseConsole.error('Failed to write project log:', e.message);
    }
}

function initProjectLogger(projectDir = PROJECT_DIR) {
    try {
        const logsDir = ensureLogsDir(projectDir);
        CURRENT_LOG_FILE = path.join(logsDir, `app-${nowStamp()}-${process.pid}.log`);
        appendProjectLog('INFO', `Logger initialized. projectDir=${projectDir}`);
    } catch (e) {
        _baseConsole.error('Failed to initialize project logger:', e.message);
        CURRENT_LOG_FILE = null;
    }
}

function getLatestProjectLogFile(projectDir = PROJECT_DIR) {
    const logsDir = ensureLogsDir(projectDir);
    try {
        const files = fs.readdirSync(logsDir)
            .filter((f) => f.toLowerCase().endsWith('.log'))
            .map((name) => {
                const file = path.join(logsDir, name);
                const stat = fs.statSync(file);
                return { file, mtimeMs: stat.mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);

        if (files.length > 0) {
            return files[0].file;
        }
    } catch (_) {
        // Fall back to current log file below
    }
    return (CURRENT_LOG_FILE && fs.existsSync(CURRENT_LOG_FILE)) ? CURRENT_LOG_FILE : null;
}

// Kill log tail PowerShell windows by matching their window title
function killLogTailWindows() {
    try {
        execSync('taskkill /FI "WINDOWTITLE eq Project Logs - Live" /F', { stdio: 'ignore' });
    } catch (_) { /* no matching window — ignore */ }
}

function tailProjectLogsLive(projectDir = PROJECT_DIR) {
    const logFile = getLatestProjectLogFile(projectDir);
    if (!logFile || !fs.existsSync(logFile)) {
        return { success: false, error: `No log file found in ${getLogsDir(projectDir)}` };
    }

    if (process.platform === 'win32') {
        try {
            // Write a small .ps1 script to temp so we can pass complex commands cleanly.
            // The script writes its own PID to a file so we can track it for cleanup.
            const escaped = logFile.replace(/'/g, "''");
            const scriptFile = path.join(projectDir, 'temp', '_logtail.ps1');

            const psScript = [
                `$Host.UI.RawUI.WindowTitle = 'Project Logs - Live'`,
                `$p = '${escaped}'`,
                `if (-not (Test-Path -LiteralPath $p)) { Write-Host 'Log file not found:' $p -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }`,
                `Write-Host 'Tailing log:' $p -ForegroundColor Cyan; Write-Host ''`,
                `Get-Content -LiteralPath $p -Tail 50 -Wait`,
            ].join('\n');

            // Ensure temp dir exists
            const tempDir = path.join(projectDir, 'temp');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            // Write with UTF-8 BOM so PowerShell correctly reads unicode characters (em dash, etc.)
            const BOM = '\uFEFF';
            fs.writeFileSync(scriptFile, BOM + psScript, 'utf8');

            // Use cmd /c start to create a visible console window
            const child = spawn('cmd.exe', [
                '/c', 'start', 'Project Logs',
                'powershell.exe',
                '-NoLogo', '-NoProfile', '-NoExit',
                '-ExecutionPolicy', 'Bypass',
                '-File', scriptFile
            ], {
                detached: true,
                stdio: 'ignore',
                shell: false,
            });
            child.unref();

            return { success: true, logFile };
        } catch (e) {
            return { success: false, error: `Failed to launch log tail: ${e.message}` };
        }
    }

    return { success: false, error: 'Live log tail is currently implemented for Windows only.' };
}

function setupConsoleTee() {
    if (console.__ytaTeePatched) return;
    console.__ytaTeePatched = true;

    console.log = (...args) => {
        _baseConsole.log(...args);
        appendProjectLog('INFO', stringifyLogArgs(args));
    };
    console.warn = (...args) => {
        _baseConsole.warn(...args);
        appendProjectLog('WARN', stringifyLogArgs(args));
    };
    console.error = (...args) => {
        _baseConsole.error(...args);
        appendProjectLog('ERROR', stringifyLogArgs(args));
    };
}

setupConsoleTee();
initProjectLogger(PROJECT_DIR);

function applyProjectDir(projectDir) {
    PROJECT_DIR = path.resolve(projectDir);
    INPUT_PATH = path.join(PROJECT_DIR, 'input');
    OUTPUT_PATH = path.join(PROJECT_DIR, 'output');
    TEMP_PATH = path.join(PROJECT_DIR, 'temp');
    PUBLIC_PATH = path.join(PROJECT_DIR, 'public');
    PROJECT_NAME = PROJECT_DIR === APP_ROOT ? '' : path.basename(PROJECT_DIR);
    ensureProjectDirs();

    // Copy .env from app root to selected project dir if needed
    const newEnvPath = path.join(PROJECT_DIR, '.env');
    if (fs.existsSync(appEnvPath) && !fs.existsSync(newEnvPath)) {
        fs.copyFileSync(appEnvPath, newEnvPath);
    }
    initProjectLogger(PROJECT_DIR);
    console.log(`📁 Active project set to: ${PROJECT_DIR}`);
}

let startupWindow = null;
let startupChoiceResolver = null;

function resolveStartupChoice(projectPath) {
    if (startupChoiceResolver) {
        const resolve = startupChoiceResolver;
        startupChoiceResolver = null;
        resolve(projectPath || null);
    }
    if (startupWindow && !startupWindow.isDestroyed()) {
        startupWindow.close();
    }
}

function createStartupWindow() {
    return new Promise((resolve) => {
        startupChoiceResolver = resolve;

        startupWindow = new BrowserWindow({
            width: 860,
            height: 560,
            minWidth: 860,
            minHeight: 560,
            resizable: false,
            maximizable: false,
            minimizable: true,
            fullscreenable: false,
            autoHideMenuBar: true,
            backgroundColor: '#0a0a0a',
            title: 'YTA Empire 2 — Start',
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js')
            },
            icon: getWindowIconPath() || undefined
        });

        startupWindow.loadFile(path.join(__dirname, 'ui', 'startup.html'));

        startupWindow.on('closed', () => {
            startupWindow = null;
            if (startupChoiceResolver) {
                const pending = startupChoiceResolver;
                startupChoiceResolver = null;
                pending(null);
            }
        });
    });
}

async function promptForExistingProjectPath(parentWindow) {
    const mode = await dialog.showMessageBox(parentWindow || null, {
        type: 'question',
        title: 'Open Project',
        message: 'How do you want to open the project?',
        detail: 'You can open by selecting the project folder, or pick a .fvp project file directly.',
        buttons: ['Project Folder', '.fvp File', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
    });

    if (mode.response === 2) {
        return null;
    }

    if (mode.response === 1) {
        const fileResult = await dialog.showOpenDialog(parentWindow || null, {
            title: 'Open .fvp project file',
            properties: ['openFile'],
            filters: [{ name: 'Project Files', extensions: ['fvp'] }],
        });
        if (fileResult.canceled || !fileResult.filePaths.length) return null;
        return path.dirname(fileResult.filePaths[0]);
    }

    const folderResult = await dialog.showOpenDialog(parentWindow || null, {
        title: 'Open existing project folder',
        properties: ['openDirectory']
    });
    if (folderResult.canceled || !folderResult.filePaths.length) return null;
    return folderResult.filePaths[0];
}

async function promptStartupProjectPath() {
    return createStartupWindow();
}

const APP_ICON_ICO = path.join(APP_ROOT, 'assets', 'icon.ico');
const APP_ICON_TASKBAR_PNG = path.join(APP_ROOT, 'assets', 'icon-taskbar.png');
const APP_ICON_PNG = path.join(APP_ROOT, 'assets', 'icon.png');

function getIconSourcePng() {
    if (fs.existsSync(APP_ICON_TASKBAR_PNG)) return APP_ICON_TASKBAR_PNG;
    return fs.existsSync(APP_ICON_PNG) ? APP_ICON_PNG : null;
}

function getIcoIconPath() {
    return fs.existsSync(APP_ICON_ICO) ? APP_ICON_ICO : null;
}

function getWindowIconPath() {
    const ico = getIcoIconPath();
    if (ico) return ico;
    return getIconSourcePng();
}

function getShortcutIconPath() {
    return getIcoIconPath() || process.execPath;
}

function ensureIcoFromPng() {
    const sourcePngPath = getIconSourcePng();
    if (!sourcePngPath) {
        return;
    }
    if (fs.existsSync(APP_ICON_ICO)) {
        const icoMtime = fs.statSync(APP_ICON_ICO).mtimeMs;
        const srcMtime = fs.statSync(sourcePngPath).mtimeMs;
        if (icoMtime >= srcMtime) {
            return;
        }
    }
    try {
        const png = fs.readFileSync(sourcePngPath);
        // PNG signature + IHDR sanity check
        const pngSig = '89504e470d0a1a0a';
        if (png.length < 24 || png.slice(0, 8).toString('hex') !== pngSig || png.toString('ascii', 12, 16) !== 'IHDR') {
            throw new Error(`${path.basename(sourcePngPath)} is not a valid PNG`);
        }

        const width = png.readUInt32BE(16);
        const height = png.readUInt32BE(20);
        const widthByte = width >= 256 ? 0 : width;
        const heightByte = height >= 256 ? 0 : height;

        // ICO header + single PNG image entry
        const icoHeader = Buffer.alloc(22);
        icoHeader.writeUInt16LE(0, 0);   // reserved
        icoHeader.writeUInt16LE(1, 2);   // type = icon
        icoHeader.writeUInt16LE(1, 4);   // image count
        icoHeader.writeUInt8(widthByte, 6);
        icoHeader.writeUInt8(heightByte, 7);
        icoHeader.writeUInt8(0, 8);      // color count
        icoHeader.writeUInt8(0, 9);      // reserved
        icoHeader.writeUInt16LE(1, 10);  // planes
        icoHeader.writeUInt16LE(32, 12); // bit count
        icoHeader.writeUInt32LE(png.length, 14);
        icoHeader.writeUInt32LE(22, 18); // offset to image data

        fs.writeFileSync(APP_ICON_ICO, Buffer.concat([icoHeader, png]));
        console.log(`✅ Generated ${APP_ICON_ICO} from ${path.basename(sourcePngPath)}`);
    } catch (e) {
        console.warn(`⚠️ Could not generate icon.ico: ${e.message}`);
    }
}

ensureIcoFromPng();

let mainWindow;

// ========================================
// Create Window
// ========================================
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
        backgroundColor: '#0a0a0a',
        titleBarStyle: 'default',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: getWindowIconPath() || undefined
    });

    // Disable caching so CSS/JS changes are picked up immediately
    mainWindow.webContents.session.clearCache();

    // Set window title with project name
    if (PROJECT_NAME) {
        mainWindow.setTitle(`YTA Empire 2 — ${PROJECT_NAME}`);
    }

    // Load the UI
    mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

    // Custom menu - let Ctrl+Z/C/V/S pass through to the renderer
    const sendToRenderer = (channel) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(channel);
        }
    };
    const menu = Menu.buildFromTemplate([
        {
            label: 'File',
            submenu: [
                { label: 'Save Project', accelerator: 'CmdOrCtrl+S', click: () => sendToRenderer('menu-save') },
                { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: () => sendToRenderer('menu-new') },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'Edit',
            submenu: [
                { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendToRenderer('menu-undo') },
                { type: 'separator' },
                { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => sendToRenderer('menu-copy') },
                { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => sendToRenderer('menu-paste') },
                { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => sendToRenderer('menu-select-all') },
                { label: 'Delete', accelerator: 'Delete', click: () => sendToRenderer('menu-delete') }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { role: 'resetZoom' }
            ]
        },
        {
            label: 'Help',
            submenu: [
                { label: 'Create Desktop Shortcut', click: async () => {
                    const result = await ipcMain.emit('create-desktop-shortcut') || {};
                    // Call directly instead of through IPC
                    try {
                        const desktopDir = path.join(require('os').homedir(), 'Desktop');
                        const shortcutPath = path.join(desktopDir, 'YTA Empire 2.lnk');
                        const electronExe = process.execPath;
                        const icon = getShortcutIconPath();
                        const ps = `$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut('${shortcutPath.replace(/'/g, "''")}'); $sc.TargetPath = '${electronExe.replace(/'/g, "''")}'; $sc.Arguments = '""${APP_ROOT.replace(/'/g, "''")}""'; $sc.WorkingDirectory = '${APP_ROOT.replace(/'/g, "''")}'; $sc.IconLocation = '${icon.replace(/'/g, "''")}'; $sc.Description = 'YTA Empire 2'; $sc.Save();`;
                        execSync(`powershell -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: 'ignore' });
                        dialog.showMessageBox(mainWindow, { title: 'Shortcut Created', message: 'Desktop shortcut created successfully!', type: 'info' });
                    } catch (e) {
                        dialog.showMessageBox(mainWindow, { title: 'Error', message: `Failed to create shortcut: ${e.message}`, type: 'error' });
                    }
                }},
                { label: 'Open Project Logs', click: async () => {
                    const logsDir = ensureLogsDir(PROJECT_DIR);
                    await shell.openPath(logsDir);
                }},
                { label: 'Tail Project Logs (Live)', click: async () => {
                    const result = tailProjectLogsLive(PROJECT_DIR);
                    if (!result.success) {
                        dialog.showMessageBox(mainWindow, {
                            title: 'Log Tail Failed',
                            message: result.error || 'Could not tail project logs.',
                            type: 'error'
                        });
                    }
                }},
                { type: 'separator' },
                { label: 'About', click: () => dialog.showMessageBox(mainWindow, { title: 'YTA Empire 2', message: 'AI-powered video generator', type: 'info' }) }
            ]
        }
    ]);
    Menu.setApplicationMenu(menu);

    // Open DevTools in development
    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    console.log('🎬 YTA Empire 2 started');
}

// ========================================
// V2 GPU-Native Export: colocate GPU thread with main process
// Required for EGL/ANGLE D3D11 device access from native addon.
// Enable with EXPORT_V2=1 environment variable.
// ========================================
// --in-process-gpu moves GPU thread into main process so native addon can
// access ANGLE's EGL display for D3D11 shared texture interop.
// --disable-gpu-compositing prevents blank window by using software UI compositing
// while keeping GPU available for WebGL rendering.
// Disable with EXPORT_V2=0 if it causes problems.
if (process.env.EXPORT_V2 !== '0') {
    app.commandLine.appendSwitch('in-process-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
    app.commandLine.appendSwitch('disable-gpu-sandbox');
    app.commandLine.appendSwitch('no-sandbox');
    console.log('[V2] --in-process-gpu + --disable-gpu-compositing ENABLED');
} else {
    console.log('[V2] --in-process-gpu DISABLED (EXPORT_V2=0)');
}

// ========================================
// App Lifecycle
// ========================================
app.setAppUserModelId('YTA Empire 2');

app.whenReady().then(async () => {
    // If app launched without an explicit project argument, ask user at startup.
    if (!hasExplicitProject) {
        const selectedProjectPath = await promptStartupProjectPath();
        if (!selectedProjectPath) {
            app.quit();
            return;
        }
        applyProjectDir(selectedProjectPath);
    }

    const lockAcquired = acquireProjectLock();

    if (!lockAcquired) {
        // Another instance is already using this project directory
        const response = await dialog.showMessageBox(null, {
            type: 'warning',
            title: 'Project Already Open',
            message: `This project folder is already open in another window:\n\n${PROJECT_DIR}`,
            detail: 'Choose a different folder to work in, or cancel to quit.',
            buttons: ['Choose Folder', 'Cancel'],
            defaultId: 0
        });

        if (response.response === 0) {
            // Let user pick a new folder
            const folderResult = await dialog.showOpenDialog(null, {
                title: 'Choose a project folder',
                properties: ['openDirectory', 'createDirectory']
            });
            if (folderResult.canceled || !folderResult.filePaths.length) {
                app.quit();
                return;
            }
            // Re-set all project paths to the new folder
            applyProjectDir(folderResult.filePaths[0]);
            // Acquire lock on new dir
            acquireProjectLock();
        } else {
            app.quit();
            return;
        }
    }

    createWindow();

    // Auto-probe V2 on startup to log GPU capabilities
    if (_gpuExportAddon && process.env.EXPORT_V2 !== '0') {
        try {
            const probe = _gpuExportAddon.probeAngleD3D11();
            if (probe.ok) {
                console.log('[V2] GPU Probe SUCCESS:');
                console.log('  Renderer:', probe.details?.renderer);
                console.log('  Adapter:', probe.details?.adapterDescription);
                console.log('  LUID:', probe.details?.adapterLuid);
                console.log('  EGL Extensions:', probe.details?.eglExtensions?.length, 'found');
            } else {
                console.log(`[V2] GPU Probe: ${probe.reason} — ${probe.error || ''}`);
            }
        } catch (e) {
            console.log('[V2] GPU Probe error:', e.message);
        }
    }
});

app.on('window-all-closed', () => {
    killLogTailWindows();
    releaseProjectLock();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    killLogTailWindows();
    releaseProjectLock();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// ========================================
// IPC Handlers (Bridge between UI and Node.js)
// ========================================

// Copy audio file to input folder
ipcMain.handle('copy-file', async (event, sourcePath, destFolder) => {
    try {
        if (!sourcePath || typeof sourcePath !== 'string') {
            return { success: false, error: 'Source path is missing or invalid' };
        }
        const destPath = destFolder === 'input' ? INPUT_PATH : destFolder;
        const fileName = path.basename(sourcePath);
        const destination = path.join(destPath, fileName);

        // Ensure folder exists
        if (!fs.existsSync(destPath)) {
            fs.mkdirSync(destPath, { recursive: true });
        }

        // Skip copy if source is already in the destination folder
        if (path.resolve(sourcePath) === path.resolve(destination)) {
            console.log(`✅ Audio already in ${destFolder}, skipping copy`);
            return { success: true, path: destination };
        }

        // Clear existing audio files in input
        const existingFiles = fs.readdirSync(destPath);
        existingFiles.forEach(file => {
            if (file.endsWith('.mp3') || file.endsWith('.wav')) {
                fs.unlinkSync(path.join(destPath, file));
            }
        });

        // Copy file
        fs.copyFileSync(sourcePath, destination);
        console.log(`✅ Copied ${fileName} to ${destFolder}`);

        return { success: true, path: destination };
    } catch (error) {
        console.error('❌ Copy failed:', error);
        return { success: false, error: error.message };
    }
});

// Active child process tracking for cancellation
let activeProcess = null;
let activeProcessType = null; // 'build' or 'render'
let processCancelled = false;

ipcMain.handle('cancel-process', async () => {
    // Cancel FFmpeg render if active (in-process async, no child process)
    let ffmpegCancelled = false;
    try {
        const { cancelRender } = require('./src/ffmpeg-renderer');
        cancelRender();
        ffmpegCancelled = true;
    } catch (e) { /* module may not be loaded */ }

    if (activeProcess) {
        const type = activeProcessType || 'process';
        const pid = activeProcess.pid;
        console.log(`⛔ Cancelling ${type} (PID: ${pid})...`);
        processCancelled = true;
        try {
            // Kill entire process tree on Windows
            if (process.platform === 'win32') {
                exec(`taskkill /pid ${pid} /f /t`, (err) => {
                    if (err) console.error('taskkill error:', err.message);
                    else console.log(`taskkill success for PID ${pid}`);
                });
            } else {
                activeProcess.kill('SIGTERM');
            }
        } catch (e) {
            console.error('Error killing process:', e);
            try { activeProcess.kill('SIGKILL'); } catch (_) {}
        }
        return { success: true, message: `${type} cancelled` };
    }

    // FFmpeg render runs in-process (no activeProcess), but cancelRender() was called
    if (ffmpegCancelled) {
        return { success: true, message: 'render cancelled' };
    }

    return { success: false, message: 'No active process' };
});

// Run the build pipeline
ipcMain.handle('run-build', async (event, options) => {
    try {
        console.log('🚀 Starting build with options:', options);

        // Update .env with AI provider and Ollama model settings
        if (options.aiProvider) {
            updateEnvFile('AI_PROVIDER', options.aiProvider);
        }
        if (options.ollamaModel) {
            updateEnvFile('OLLAMA_MODEL', options.ollamaModel);
        }
        if (options.ollamaVisionModel) {
            updateEnvFile('OLLAMA_VISION_MODEL', options.ollamaVisionModel);
        }

        // Send progress updates to renderer
        const sendProgress = (percent, message) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('build-progress', { percent, message });
            }
        };

        sendProgress(10, '🎙️ Transcribing audio...');

        // Run the build script
        return new Promise((resolve, reject) => {
            const buildEnv = { ...process.env, FORCE_COLOR: '0', PROJECT_DIR: PROJECT_DIR };
            // Pass explicit audio filename so build uses the correct file
            if (options.audioFileName) {
                buildEnv.BUILD_AUDIO_FILE = options.audioFileName;
            }
            // Pass enabled footage sources as JSON
            if (options.footageSources) {
                buildEnv.FOOTAGE_SOURCES = JSON.stringify(options.footageSources);
            }
            // Pass AI instructions for prompt guidance
            if (options.aiInstructions) {
                buildEnv.AI_INSTRUCTIONS = options.aiInstructions;
            }
            // Pass build settings (quality, format, theme)
            if (options.buildQuality) {
                buildEnv.BUILD_QUALITY_TIER = options.buildQuality;
            }
            if (options.buildFormat) {
                buildEnv.BUILD_FORMAT = options.buildFormat;
            }
            if (options.buildTheme) {
                buildEnv.BUILD_THEME = options.buildTheme;
            }
            // Also pass DOTENV_PATH so build pipeline loads the project-local .env
            buildEnv.DOTENV_PATH = path.join(PROJECT_DIR, '.env');
            const buildProcess = spawn('node', ['src/build-video.js'], {
                cwd: APP_ROOT,
                shell: true,
                env: buildEnv
            });
            activeProcess = buildProcess;
            activeProcessType = 'build';
            processCancelled = false;

            let output = '';
            let errorOutput = '';

            buildProcess.stdout.on('data', (data) => {
                const text = data.toString();
                output += text;
                console.log(text);

                // Parse progress from output (matches console.log in build-video.js)
                if (text.includes('Transcribing')) sendProgress(15, '🎙️ Transcribing audio...');
                if (text.includes('Creating scenes')) sendProgress(25, '📝 Creating scenes...');
                if (text.includes('Analyzing script context')) sendProgress(30, '🧠 Understanding script context...');
                if (text.includes('AI selecting') || text.includes('AI is analyzing')) sendProgress(40, '🤖 AI selecting keywords...');
                if (text.includes('Downloading')) sendProgress(55, '🎥 Downloading stock footage...');
                if (text.includes('Analyzing downloaded') || text.includes('Vision AI')) sendProgress(65, '👁️ Analyzing footage visuals...');
                if (text.includes('motion graphics')) sendProgress(75, '✨ Placing motion graphics...');
                if (text.includes('Creating video plan')) sendProgress(85, '📋 Creating video plan...');
                if (text.includes('Copying files')) sendProgress(90, '📂 Preparing files...');
                if (text.includes('BUILD COMPLETE')) sendProgress(100, '✅ Build complete!');
            });

            buildProcess.stderr.on('data', (data) => {
                errorOutput += data.toString();
                console.error(data.toString());
            });

            buildProcess.on('close', (code) => {
                const wasCancelled = processCancelled;
                activeProcess = null;
                activeProcessType = null;
                processCancelled = false;
                if (wasCancelled) {
                    console.log('⛔ Build was cancelled by user');
                    resolve({ success: false, error: 'Cancelled' });
                    return;
                }
                if (code === 0) {
                    // Inject transitionStyle into video plan if provided
                    if (options.transitionStyle) {
                        try {
                            const planPaths = [
                                path.join(TEMP_PATH, 'video-plan.json'),
                                path.join(PUBLIC_PATH, 'video-plan.json')
                            ];
                            for (const p of planPaths) {
                                if (fs.existsSync(p)) {
                                    const plan = JSON.parse(fs.readFileSync(p, 'utf8'));
                                    plan.transitionStyle = options.transitionStyle;
                                    fs.writeFileSync(p, JSON.stringify(plan, null, 2));
                                }
                            }
                        } catch (e) {
                            console.error('Failed to inject transitionStyle:', e);
                        }
                    }
                    resolve({ success: true, output });
                } else {
                    resolve({ success: false, error: errorOutput || 'Build failed' });
                }
            });

            buildProcess.on('error', (err) => {
                resolve({ success: false, error: err.message });
            });
        });

    } catch (error) {
        console.error('❌ Build error:', error);
        return { success: false, error: error.message };
    }
});

// Load video plan
ipcMain.handle('load-video-plan', async () => {
    try {
        // Try public folder first (where build-video.js copies files)
        const publicPlanPath = path.join(PUBLIC_PATH, 'video-plan.json');
        if (fs.existsSync(publicPlanPath)) {
            const data = fs.readFileSync(publicPlanPath, 'utf8');
            console.log('✅ Loaded video plan from public folder');
            return JSON.parse(data);
        }

        // Fall back to temp folder
        const tempPlanPath = path.join(TEMP_PATH, 'video-plan.json');
        if (fs.existsSync(tempPlanPath)) {
            const data = fs.readFileSync(tempPlanPath, 'utf8');
            console.log('✅ Loaded video plan from temp folder');
            return JSON.parse(data);
        }

        console.log('⚠️ No video plan found');
        return null;
    } catch (error) {
        console.error('❌ Failed to load video plan:', error);
        return null;
    }
});

// Save Video Plan
ipcMain.handle('save-video-plan', async (event, plan) => {
    try {
        // Save to both temp and public to be safe
        const paths = [
            path.join(TEMP_PATH, 'video-plan.json'),
            path.join(PUBLIC_PATH, 'video-plan.json')
        ];

        const data = JSON.stringify(plan, null, 2);

        paths.forEach(p => {
            // Ensure directory exists
            const dir = path.dirname(p);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(p, data);
        });

        console.log('✅ Video plan saved from UI');
        return { success: true };
    } catch (error) {
        console.error('❌ Failed to save plan:', error);
        return { success: false, error: error.message };
    }
});

// ========================================
// Project File (.fvp) Save/Load
// ========================================

// Project file path computed dynamically (PROJECT_DIR may change on lock conflict redirect)
// Named after the project folder (e.g., "My Video Project.fvp")
function getProjectFilePath() {
    const name = path.basename(PROJECT_DIR) || 'project';
    return path.join(PROJECT_DIR, name + '.fvp');
}
const RECENT_PROJECTS_FILE = path.join(APP_ROOT, 'recent-projects.json');

// Save .fvp project file (video plan + editor settings unified)
ipcMain.handle('save-project-file', async (event, data) => {
    try {
        const fvpData = {
            version: 1,
            savedAt: new Date().toISOString(),
            settings: data.settings || {},
            videoPlan: data.videoPlan || {}
        };

        // Write .fvp file to project root
        fs.writeFileSync(getProjectFilePath(), JSON.stringify(fvpData, null, 2));

        // Also write video-plan.json to public/ and temp/ (Remotion render needs it)
        if (data.videoPlan) {
            const planData = JSON.stringify(data.videoPlan, null, 2);
            [path.join(PUBLIC_PATH, 'video-plan.json'), path.join(TEMP_PATH, 'video-plan.json')].forEach(p => {
                const dir = path.dirname(p);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(p, planData);
            });
        }

        // Add to recent projects list
        _addRecentProject(PROJECT_DIR);

        console.log('✅ Project file saved:', getProjectFilePath());
        return { success: true, path: getProjectFilePath() };
    } catch (error) {
        console.error('❌ Failed to save project file:', error);
        return { success: false, error: error.message };
    }
});

// Load .fvp project file
ipcMain.handle('load-project-file', async () => {
    try {
        // Try expected .fvp name first, then scan for any .fvp in project dir
        let fvpPath = getProjectFilePath();
        if (!fs.existsSync(fvpPath)) {
            // Scan for any .fvp file (handles renamed projects or legacy "project.fvp")
            const files = fs.readdirSync(PROJECT_DIR).filter(f => f.endsWith('.fvp'));
            if (files.length > 0) fvpPath = path.join(PROJECT_DIR, files[0]);
            else fvpPath = null;
        }
        if (fvpPath) {
            const data = JSON.parse(fs.readFileSync(fvpPath, 'utf8'));
            console.log('✅ Loaded project from .fvp file:', fvpPath);
            return data;
        }

        // Fallback: migrate from video-plan.json (old format, no settings)
        const publicPlan = path.join(PUBLIC_PATH, 'video-plan.json');
        const tempPlan = path.join(TEMP_PATH, 'video-plan.json');
        const planPath = fs.existsSync(publicPlan) ? publicPlan : (fs.existsSync(tempPlan) ? tempPlan : null);

        if (planPath) {
            const videoPlan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
            console.log('✅ Loaded video plan from legacy JSON (no .fvp found, will migrate on save)');
            return { version: 1, savedAt: null, settings: null, videoPlan };
        }

        return null;
    } catch (error) {
        console.error('❌ Failed to load project file:', error);
        return null;
    }
});

// Get recent projects list
ipcMain.handle('get-recent-projects', async () => {
    try {
        if (fs.existsSync(RECENT_PROJECTS_FILE)) {
            return JSON.parse(fs.readFileSync(RECENT_PROJECTS_FILE, 'utf8'));
        }
        return [];
    } catch (e) {
        return [];
    }
});

// Add to recent projects list
ipcMain.handle('add-recent-project', async () => {
    _addRecentProject(PROJECT_DIR);
    return { success: true };
});

function _addRecentProject(projectDir) {
    try {
        let recent = [];
        if (fs.existsSync(RECENT_PROJECTS_FILE)) {
            recent = JSON.parse(fs.readFileSync(RECENT_PROJECTS_FILE, 'utf8'));
        }
        // Remove duplicate, add to front, keep max 20
        recent = recent.filter(r => r.path !== projectDir);
        const projectName = path.basename(projectDir) || projectDir;
        recent.unshift({ path: projectDir, name: projectName, lastOpened: new Date().toISOString() });
        if (recent.length > 20) recent = recent.slice(0, 20);
        fs.writeFileSync(RECENT_PROJECTS_FILE, JSON.stringify(recent, null, 2));
    } catch (e) {
        console.warn('Could not update recent projects:', e.message);
    }
}

// Get scene media path (video or image) for preview
ipcMain.handle('get-scene-media-path', async (event, sceneIndex, extension, prefix) => {
    try {
        const filePrefix = prefix || 'scene';
        // Try with provided extension first, then try common extensions
        const extensions = extension ? [extension] : ['.mp4', '.jpg', '.jpeg', '.png', '.webp'];
        for (const ext of extensions) {
            const publicPath = path.join(PUBLIC_PATH, `${filePrefix}-${sceneIndex}${ext}`);
            if (fs.existsSync(publicPath)) return publicPath;
            const tempPath = path.join(TEMP_PATH, `${filePrefix}-${sceneIndex}${ext}`);
            if (fs.existsSync(tempPath)) return tempPath;
        }
        return null;
    } catch (error) {
        console.error('❌ Failed to get scene media path:', error);
        return null;
    }
});

// Backward compatibility: get scene video path
ipcMain.handle('get-scene-video-path', async (event, sceneIndex) => {
    try {
        const extensions = ['.mp4', '.jpg', '.jpeg', '.png', '.webp'];
        for (const ext of extensions) {
            const publicPath = path.join(PUBLIC_PATH, `scene-${sceneIndex}${ext}`);
            if (fs.existsSync(publicPath)) return publicPath;
            const tempPath = path.join(TEMP_PATH, `scene-${sceneIndex}${ext}`);
            if (fs.existsSync(tempPath)) return tempPath;
        }
        return null;
    } catch (error) {
        console.error('❌ Failed to get scene video path:', error);
        return null;
    }
});

// Get audio path for preview
ipcMain.handle('get-audio-path', async (event, filename) => {
    try {
        if (!filename) return null;

        // Check public folder
        const publicPath = path.join(PUBLIC_PATH, filename);
        if (fs.existsSync(publicPath)) {
            return publicPath;
        }

        // Check temp folder
        const tempPath = path.join(TEMP_PATH, filename);
        if (fs.existsSync(tempPath)) {
            return tempPath;
        }

        // Check input folder (fallback)
        const inputPath = path.join(INPUT_PATH, filename);
        if (fs.existsSync(inputPath)) {
            return inputPath;
        }

        return null;
    } catch (error) {
        console.error('❌ Failed to get audio path:', error);
        return null;
    }
});

function normalizeMediaExt(ext, isImage) {
    if (!ext || typeof ext !== 'string') return isImage ? '.jpg' : '.mp4';
    const normalized = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
    return normalized;
}

function findExistingSceneFileInDir(dir, idx, exts) {
    for (const ext of exts) {
        const p = path.join(dir, `scene-${idx}${ext}`);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

/**
 * Ensure every scene referenced by video-plan.json exists in /public before rendering.
 * This prevents mass 404s from crashing/stressing the compositor on long GPU renders.
 */
function ensureRenderSceneFiles(plan) {
    if (!plan || !Array.isArray(plan.scenes)) {
        return { repaired: 0, unresolved: 0, scanned: 0 };
    }

    let repaired = 0;
    let unresolved = 0;
    let scanned = 0;
    let fileIdx = 0;

    const lastGoodByExt = new Map();
    const imageExts = ['.jpg', '.jpeg', '.png', '.webp'];
    const videoExts = ['.mp4'];

    for (const scene of plan.scenes) {
        if (scene?.isMGScene) continue;
        scanned++;

        const isImage = scene.mediaType === 'image';
        const expectedExt = isImage
            ? normalizeMediaExt(scene.mediaExtension, true)
            : '.mp4'; // Composition always loads video scenes as .mp4
        const dest = path.join(PUBLIC_PATH, `scene-${fileIdx}${expectedExt}`);

        if (fs.existsSync(dest)) {
            lastGoodByExt.set(expectedExt, dest);
            fileIdx++;
            continue;
        }

        const candidates = [];

        // Candidate 1: scene.mediaFile absolute path or basename in common dirs
        if (typeof scene.mediaFile === 'string' && scene.mediaFile.trim()) {
            const raw = scene.mediaFile.trim();
            if (path.isAbsolute(raw)) {
                candidates.push(raw);
            } else {
                candidates.push(path.join(PUBLIC_PATH, raw));
                candidates.push(path.join(TEMP_PATH, raw));
                candidates.push(path.join(INPUT_PATH, raw));
                candidates.push(path.join(PUBLIC_PATH, path.basename(raw)));
                candidates.push(path.join(TEMP_PATH, path.basename(raw)));
            }
        }

        // Candidate 2: indexed scene files in temp/public
        const idxCandidates = [scene.index, scene._fileIndex, fileIdx]
            .filter((v) => Number.isInteger(v) && v >= 0);
        const probeExts = isImage
            ? [expectedExt, ...imageExts.filter((e) => e !== expectedExt)]
            : ['.mp4'];
        for (const idx of idxCandidates) {
            const hitPublic = findExistingSceneFileInDir(PUBLIC_PATH, idx, probeExts);
            if (hitPublic) candidates.push(hitPublic);
            const hitTemp = findExistingSceneFileInDir(TEMP_PATH, idx, probeExts);
            if (hitTemp) candidates.push(hitTemp);
        }

        // Candidate 3: previous good file with same expected extension
        if (lastGoodByExt.has(expectedExt)) {
            candidates.push(lastGoodByExt.get(expectedExt));
        }

        // Candidate 4: any existing scene file of expected extension in temp/public
        const anyByExpected = [
            ...fs.readdirSync(TEMP_PATH).filter((n) => n.startsWith('scene-') && n.toLowerCase().endsWith(expectedExt)),
            ...fs.readdirSync(PUBLIC_PATH).filter((n) => n.startsWith('scene-') && n.toLowerCase().endsWith(expectedExt))
        ].map((n) => (fs.existsSync(path.join(TEMP_PATH, n)) ? path.join(TEMP_PATH, n) : path.join(PUBLIC_PATH, n)));
        if (anyByExpected.length > 0) {
            candidates.push(anyByExpected[0]);
        }

        // Candidate 5 (images only): any image file if exact extension not found
        if (isImage) {
            for (const ext of imageExts) {
                if (ext === expectedExt) continue;
                if (lastGoodByExt.has(ext)) candidates.push(lastGoodByExt.get(ext));
                const anyTemp = fs.readdirSync(TEMP_PATH).find((n) => n.startsWith('scene-') && n.toLowerCase().endsWith(ext));
                if (anyTemp) candidates.push(path.join(TEMP_PATH, anyTemp));
                const anyPublic = fs.readdirSync(PUBLIC_PATH).find((n) => n.startsWith('scene-') && n.toLowerCase().endsWith(ext));
                if (anyPublic) candidates.push(path.join(PUBLIC_PATH, anyPublic));
            }
        }

        const source = candidates.find((c) => c && fs.existsSync(c));
        if (source) {
            fs.copyFileSync(source, dest);
            repaired++;
            lastGoodByExt.set(expectedExt, dest);
            console.log(`   ⚠️ Recovered missing scene-${fileIdx}${expectedExt} from ${path.basename(source)}`);
        } else {
            unresolved++;
            console.log(`   ❌ Missing scene-${fileIdx}${expectedExt} and no fallback source found`);
        }

        fileIdx++;
    }

    return { repaired, unresolved, scanned };
}

// Render video with Remotion
ipcMain.handle('run-render', async () => {
    try {
        console.log('🎬 Starting Remotion render...');

        const isWindows = process.platform === 'win32';
        let remotionBinariesDir = null;

        // Check if Remotion CLI is installed
        // Use the JS entry point directly (not .cmd wrapper) to avoid Windows EPERM
        // when multiple instances try to spawn the same .cmd file simultaneously
        const remotionCliJs = path.join(APP_ROOT, 'node_modules', '@remotion', 'cli', 'remotion-cli.js');
        const remotionBinLegacy = path.join(APP_ROOT, 'node_modules', '.bin', isWindows ? 'remotion.cmd' : 'remotion');
        if (!fs.existsSync(remotionCliJs) && !fs.existsSync(remotionBinLegacy)) {
            return {
                success: false,
                error: 'Remotion is not installed. Run: npm install remotion @remotion/cli @remotion/bundler react react-dom'
            };
        }

        if (isWindows) {
            remotionBinariesDir = ensureWindowsRemotionBinariesDir();
        }

        // Copy SFX assets to public for Remotion to access via staticFile()
        const sfxSourceDir = path.join(APP_ROOT, 'assets', 'sfx');
        if (fs.existsSync(sfxSourceDir)) {
            const sfxFiles = fs.readdirSync(sfxSourceDir).filter(f => f.endsWith('.mp3') || f.endsWith('.wav'));
            for (const f of sfxFiles) {
                const dest = path.join(PUBLIC_PATH, f);
                if (!fs.existsSync(dest)) {
                    fs.copyFileSync(path.join(sfxSourceDir, f), dest);
                }
            }
        }

        // Ensure output folder exists
        if (!fs.existsSync(OUTPUT_PATH)) {
            fs.mkdirSync(OUTPUT_PATH, { recursive: true });
        }

        // Ensure plan is available in public for staticFile('video-plan.json')
        const publicPlanPath = path.join(PUBLIC_PATH, 'video-plan.json');
        const tempPlanPath = path.join(TEMP_PATH, 'video-plan.json');
        if (!fs.existsSync(publicPlanPath) && fs.existsSync(tempPlanPath)) {
            fs.copyFileSync(tempPlanPath, publicPlanPath);
            console.log(`Copied plan to public: ${publicPlanPath}`);
        }
        if (!fs.existsSync(publicPlanPath)) {
            return {
                success: false,
                error: `video-plan.json not found for this project.\nExpected: ${publicPlanPath}\nRun Generate first, then try Render again.`
            };
        }

        let renderPlan = null;
        try {
            renderPlan = JSON.parse(fs.readFileSync(publicPlanPath, 'utf8'));
        } catch (planError) {
            return {
                success: false,
                error: `Failed to read video-plan.json: ${planError.message}`
            };
        }

        // Preflight: repair missing scene-N files in /public so render workers don't spam 404s.
        // This is especially important for long GPU renders where compositor stability matters.
        const repairStats = ensureRenderSceneFiles(renderPlan);
        if (repairStats.scanned > 0) {
            console.log(
                `Scene file preflight: scanned=${repairStats.scanned}, repaired=${repairStats.repaired}, unresolved=${repairStats.unresolved}`
            );
        }
        if (repairStats.unresolved > 0) {
            console.log(
                `⚠️ ${repairStats.unresolved} scene files are still missing. Render may show black frames for those scenes.`
            );
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const outputFile = path.join(OUTPUT_PATH, `video-${timestamp}.mp4`);

        // Send initial progress
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('render-progress', { percent: 5, message: 'Starting render...' });
        }

        return new Promise((resolve, reject) => {
            // Render concurrency tuning:
            // GPU + long videos can become unstable with high Chromium concurrency on some systems.
            const cpuCount = require('os').cpus().length;
            const defaultConcurrency = Math.max(2, Math.floor(cpuCount * 0.5));
            const gpuCapRaw = parseInt(process.env.RENDER_GPU_MAX_CONCURRENCY || '4', 10);
            const gpuConcurrencyCap = Number.isFinite(gpuCapRaw) && gpuCapRaw > 0 ? gpuCapRaw : 4;
            const estimatedFrames = (() => {
                const duration = Number(renderPlan?.totalDuration);
                const fpsFromPlan = Number(renderPlan?.fps || 30);
                if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(fpsFromPlan) || fpsFromPlan <= 0) {
                    return null;
                }
                return Math.ceil(duration * fpsFromPlan);
            })();
            const longVideoAutoCapEnabled = process.env.RENDER_GPU_LONG_VIDEO_CAP !== '0';
            let effectiveGpuCap = gpuConcurrencyCap;
            if (longVideoAutoCapEnabled && Number.isFinite(estimatedFrames)) {
                if (estimatedFrames >= 24000) {
                    effectiveGpuCap = Math.min(effectiveGpuCap, 1);
                } else if (estimatedFrames >= 12000) {
                    effectiveGpuCap = Math.min(effectiveGpuCap, 2);
                }
            }
            const concurrency = Math.max(1, Math.min(defaultConcurrency, effectiveGpuCap));
            if (Number.isFinite(estimatedFrames)) {
                console.log(`Estimated render length: ${estimatedFrames} frames`);
            }
            if (effectiveGpuCap !== gpuConcurrencyCap) {
                console.log(`Applying long-render GPU cap: ${effectiveGpuCap} (original cap=${gpuConcurrencyCap})`);
            }
            console.log(`Rendering with ${concurrency} threads (${cpuCount} CPU cores detected, GPU cap=${effectiveGpuCap})`);

            // Use node + JS entry point directly to avoid Windows .cmd EPERM
            // when multiple instances render simultaneously
            const useDirectJs = fs.existsSync(remotionCliJs);
            // Use Electron's bundled Node runtime for direct JS execution to avoid
            // system-Node compatibility issues (e.g. non-LTS Node 21 crashes).
            const spawnCmd = useDirectJs ? process.execPath : remotionBinLegacy;
            const useShell = !useDirectJs && isWindows;
            const shellQuotePath = (p) => (useShell && /\s/.test(p) ? `"${p}"` : p);
            const spawnArgs = [
                ...(useDirectJs ? [remotionCliJs] : []),
                'render',
                'src/remotion/Root.jsx',
                'FacelessVideo',
                shellQuotePath(outputFile),
                `--concurrency=${concurrency}`,
                '--hardware-acceleration=if-possible',
                '--gl=angle',
                `--public-dir=${shellQuotePath(PUBLIC_PATH)}`,
                '--bundle-cache=false',
                ...(remotionBinariesDir ? [`--binaries-directory=${shellQuotePath(remotionBinariesDir)}`] : [])
            ];
            console.log(`🎮 GPU Rendering: ENABLED (if available, NVIDIA NVENC + ANGLE GL)`);
            console.log(`Spawning: ${spawnCmd} ${spawnArgs.join(' ')}`);
            console.log(`Public dir: ${PUBLIC_PATH}`);

            const renderProcess = spawn(spawnCmd, spawnArgs, {
                cwd: APP_ROOT,
                shell: useShell,
                env: {
                    ...process.env,
                    ...(useDirectJs ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
                    FORCE_COLOR: '0',
                    PROJECT_DIR: PROJECT_DIR,
                    // Tell Remotion where to find public assets (video-plan.json, scene files, etc.)
                    REMOTION_PUBLIC_DIR: PUBLIC_PATH
                }
            });
            activeProcess = renderProcess;
            activeProcessType = 'render';
            processCancelled = false;

            let output = '';
            let errorOutput = '';
            let encoderMode = 'unknown'; // gpu | cpu | unknown
            let didFallbackToCpu = false;
            let modeBannerPrinted = false;

            const detectEncoderMode = (text, forceCpu = false) => {
                const t = String(text || '');

                // If this stream is from fallback process, it's CPU mode by definition.
                if (forceCpu && encoderMode !== 'cpu') {
                    encoderMode = 'cpu';
                    console.log('RUNNING ON CPU: fallback render process is active');
                    modeBannerPrinted = true;
                    return;
                }

                if (/(h264_nvenc|hevc_nvenc)/i.test(t) && encoderMode !== 'gpu') {
                    encoderMode = 'gpu';
                    console.log('RUNNING ON GPU: NVENC encoder confirmed');
                    modeBannerPrinted = true;
                    return;
                }

                if (/(libx264|libx265)/i.test(t) && encoderMode !== 'cpu') {
                    encoderMode = 'cpu';
                    console.log('RUNNING ON CPU: software encoder detected');
                    modeBannerPrinted = true;
                }
            };

            const parseProgress = (text) => {
                if (!mainWindow || mainWindow.isDestroyed()) return;

                // Match "Rendered X/Y" (rendering phase = 0-80%)
                const renderMatch = text.match(/Rendered\s+(\d+)\s*\/\s*(\d+)/);
                if (renderMatch) {
                    const current = parseInt(renderMatch[1]);
                    const total = parseInt(renderMatch[2]);
                    const percent = Math.round((current / total) * 80);
                    mainWindow.webContents.send('render-progress', {
                        percent,
                        message: `Rendering: ${current}/${total} frames`
                    });
                    return;
                }

                // Match "Encoded X/Y" (encoding phase = 80-100%)
                const encodeMatch = text.match(/Encoded\s+(\d+)\s*\/\s*(\d+)/);
                if (encodeMatch) {
                    const current = parseInt(encodeMatch[1]);
                    const total = parseInt(encodeMatch[2]);
                    const percent = 80 + Math.round((current / total) * 20);
                    mainWindow.webContents.send('render-progress', {
                        percent,
                        message: `Encoding: ${current}/${total} frames`
                    });
                    return;
                }
            };

            const startCpuFallback = () => {
                didFallbackToCpu = true;
                console.log('FELL BACK TO CPU: continuing render with software encoding');
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('render-progress', { percent: 5, message: 'GPU unavailable, retrying with CPU...' });
                }
                const cpuArgs = spawnArgs
                    .map((a) => a.startsWith('--hardware-acceleration=') ? '--hardware-acceleration=disable' : a)
                    .filter((a) => !a.startsWith('--gl='))
                    .map((a) => a.startsWith('--concurrency=') ? `--concurrency=${Math.max(1, Math.min(concurrency, 2))}` : a);
                const cpuProcess = spawn(spawnCmd, cpuArgs, {
                    cwd: APP_ROOT, shell: useShell,
                    env: {
                        ...process.env,
                        ...(useDirectJs ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
                        FORCE_COLOR: '0',
                        PROJECT_DIR: PROJECT_DIR,
                        REMOTION_PUBLIC_DIR: PUBLIC_PATH
                    }
                });
                activeProcess = cpuProcess;
                activeProcessType = 'render';
                cpuProcess.stdout.on('data', (d) => {
                    const t = d.toString();
                    console.log(t);
                    detectEncoderMode(t, true);
                    parseProgress(t);
                });
                cpuProcess.stderr.on('data', (d) => {
                    const t = d.toString();
                    console.error(t);
                    detectEncoderMode(t, true);
                    parseProgress(t);
                });
                cpuProcess.on('close', (cpuCode) => {
                    activeProcess = null; activeProcessType = null;
                    if (fs.existsSync(outputFile)) {
                        console.log('✅ CPU fallback render complete:', outputFile);
                        console.log('FINAL RENDER MODE: CPU (fallback)');
                        resolve({ success: true, outputPath: outputFile });
                    } else {
                        resolve({ success: false, error: `Render failed (GPU + CPU). Code: ${cpuCode}` });
                    }
                });
                cpuProcess.on('error', (e) => resolve({ success: false, error: e.message }));
            };

            const upsertFlag = (args, prefix, value) => {
                const val = `${prefix}${value}`;
                let found = false;
                const next = args.map((a) => {
                    if (a.startsWith(prefix)) {
                        found = true;
                        return val;
                    }
                    return a;
                });
                if (!found) {
                    next.push(val);
                }
                return next;
            };

            const removeFlag = (args, prefix) => args.filter((a) => !a.startsWith(prefix));

            const startSafeGpuRetry = () => {
                const retryProfiles = [
                    { label: 'angle-egl', gl: 'angle-egl' },
                    { label: 'vulkan', gl: 'vulkan' },
                    { label: 'auto-gl', gl: null },
                ];

                const runProfile = (idx) => {
                    if (idx >= retryProfiles.length) {
                        console.log('⚠️ All GPU retry profiles failed, switching to CPU fallback...');
                        startCpuFallback();
                        return;
                    }

                    const profile = retryProfiles[idx];
                    let profileArgs = [...spawnArgs];
                    profileArgs = upsertFlag(profileArgs, '--concurrency=', 1);
                    profileArgs = upsertFlag(profileArgs, '--offthreadvideo-threads=', 1);
                    profileArgs = upsertFlag(profileArgs, '--offthreadvideo-cache-size-in-bytes=', 268435456);
                    profileArgs = upsertFlag(profileArgs, '--media-cache-size-in-bytes=', 268435456);
                    if (profile.gl === null) {
                        profileArgs = removeFlag(profileArgs, '--gl=');
                    } else {
                        profileArgs = upsertFlag(profileArgs, '--gl=', profile.gl);
                    }

                    console.log(
                        `🔁 Retrying GPU with profile ${idx + 1}/${retryProfiles.length}: ` +
                        `gl=${profile.gl ?? 'auto'}, concurrency=1, offthreadvideo-threads=1`
                    );

                    const safeGpuProcess = spawn(spawnCmd, profileArgs, {
                        cwd: APP_ROOT,
                        shell: useShell,
                        env: {
                            ...process.env,
                            ...(useDirectJs ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
                            FORCE_COLOR: '0',
                            PROJECT_DIR: PROJECT_DIR,
                            REMOTION_PUBLIC_DIR: PUBLIC_PATH
                        }
                    });

                    activeProcess = safeGpuProcess;
                    activeProcessType = 'render';

                    safeGpuProcess.stdout.on('data', (d) => {
                        const t = d.toString();
                        console.log(t);
                        detectEncoderMode(t);
                        parseProgress(t);
                    });

                    safeGpuProcess.stderr.on('data', (d) => {
                        const t = d.toString();
                        console.error(t);
                        detectEncoderMode(t);
                        parseProgress(t);
                    });

                    safeGpuProcess.on('close', (safeCode) => {
                        activeProcess = null;
                        activeProcessType = null;

                        if (fs.existsSync(outputFile)) {
                            console.log(`✅ GPU retry profile '${profile.label}' completed:`, outputFile);
                            console.log(`FINAL RENDER MODE: GPU (${profile.label})`);
                            resolve({ success: true, outputPath: outputFile });
                            return;
                        }

                        console.log(
                            `⚠️ GPU retry profile '${profile.label}' failed (code=${safeCode}), trying next profile...`
                        );
                        runProfile(idx + 1);
                    });

                    safeGpuProcess.on('error', () => {
                        console.log(`⚠️ GPU retry profile '${profile.label}' process error, trying next profile...`);
                        runProfile(idx + 1);
                    });
                };

                runProfile(0);
            };

            renderProcess.stdout.on('data', (data) => {
                const text = data.toString();
                output += text;
                console.log(text);
                detectEncoderMode(text);
                parseProgress(text);
            });

            let gpuConfirmed = false;
            renderProcess.stderr.on('data', (data) => {
                const text = data.toString();
                errorOutput += text;
                console.error(text);
                detectEncoderMode(text);
                parseProgress(text);

                // Detect GPU encoder in use
                if (!gpuConfirmed) {
                    if (text.includes('h264_nvenc') || text.includes('hevc_nvenc')) {
                        console.log('✅ GPU ENCODING ACTIVE: NVIDIA NVENC confirmed');
                        gpuConfirmed = true;
                    } else if (text.includes('libx264') || text.includes('libx265')) {
                        console.log('⚠️ CPU ENCODING: Using libx264 (GPU not active)');
                        gpuConfirmed = true;
                    }
                    if (text.includes('Encoder:')) {
                        console.log(`🎬 ${text.trim()}`);
                    }
                }
            });

            renderProcess.on('close', (code) => {
                const wasCancelled = processCancelled;
                activeProcess = null;
                activeProcessType = null;
                processCancelled = false;
                console.log('Render process exited with code:', code, 'cancelled:', wasCancelled);

                if (wasCancelled) {
                    console.log('⛔ Render was cancelled by user');
                    resolve({ success: false, error: 'Cancelled' });
                    return;
                }

                if (fs.existsSync(outputFile)) {
                    console.log('✅ Render complete:', outputFile);
                    if (didFallbackToCpu) {
                        console.log('FINAL RENDER MODE: CPU (fallback)');
                    } else if (encoderMode === 'gpu') {
                        console.log('FINAL RENDER MODE: GPU');
                    } else if (encoderMode === 'cpu') {
                        console.log('FINAL RENDER MODE: CPU');
                    } else {
                        console.log('FINAL RENDER MODE: GPU path (encoder not explicitly reported)');
                        if (!modeBannerPrinted) {
                            console.log('RUNNING ON GPU: hardware-acceleration path stayed active (no CPU fallback)');
                        }
                    }
                    resolve({
                        success: true,
                        outputPath: outputFile
                    });
                } else if (code === 0) {
                    // Check if file exists in default location
                    const defaultOutput = path.join(OUTPUT_PATH, 'video.mp4');
                    if (fs.existsSync(defaultOutput)) {
                        resolve({ success: true, outputPath: defaultOutput });
                    } else {
                        resolve({ success: false, error: 'Render completed but output file not found' });
                    }
                } else {
                    // If GPU/compositor path failed, auto-retry with CPU
                    const nvencFailed = errorOutput.includes('nvenc') ||
                                       errorOutput.includes('NVENC') ||
                                       errorOutput.includes('hardware acceleration') ||
                                       errorOutput.includes('No capable devices found');
                    const compositorPipeFailed =
                        /write EOF/i.test(errorOutput) ||
                        /Could not extract frame from compositor/i.test(errorOutput) ||
                        /Request closed/i.test(errorOutput) ||
                        /syscall:\s*'write'/i.test(errorOutput) ||
                        /compositor/i.test(errorOutput);
                    const gpuPathEnabled = spawnArgs.some((a) =>
                        a.startsWith('--hardware-acceleration=') && a !== '--hardware-acceleration=disable'
                    );

                    if ((nvencFailed || compositorPipeFailed) && gpuPathEnabled) {
                        if (compositorPipeFailed) {
                            console.log('⚠️ GPU compositor stream failed (write EOF / request closed). Trying GPU recovery profiles...');
                        } else {
                            console.log('⚠️ NVENC GPU render failed, trying GPU recovery profiles...');
                        }
                        const allowSafeGpuRetry = process.env.RENDER_GPU_SAFE_RETRY !== '0';
                        if (allowSafeGpuRetry) {
                            startSafeGpuRetry();
                        } else {
                            startCpuFallback();
                        }
                        return;
                    }

                    // Provide helpful error message
                    let errorMsg = errorOutput || `Render failed with code ${code}`;
                    if (errorMsg.includes('EPERM') || errorMsg.includes('ENOENT')) {
                        errorMsg += '\n\nThis may be caused by Windows Defender blocking Remotion files. ' +
                                   'Add an exclusion in Windows Security for your node_modules folder.';
                    }
                    resolve({ success: false, error: errorMsg });
                }
            });

            renderProcess.on('error', (err) => {
                console.error('Render process error:', err);
                resolve({ success: false, error: err.message });
            });
        });

    } catch (error) {
        console.error('❌ Render error:', error);
        return { success: false, error: error.message };
    }
});

// Render video with FFmpeg (GPU-accelerated)
ipcMain.handle('run-render-ffmpeg', async () => {
    try {
        console.log('🎬 Starting FFmpeg GPU render...');

        // Ensure output folder exists
        if (!fs.existsSync(OUTPUT_PATH)) {
            fs.mkdirSync(OUTPUT_PATH, { recursive: true });
        }

        // Load video plan
        const publicPlanPath = path.join(PUBLIC_PATH, 'video-plan.json');
        const tempPlanPath = path.join(TEMP_PATH, 'video-plan.json');
        if (!fs.existsSync(publicPlanPath) && fs.existsSync(tempPlanPath)) {
            fs.copyFileSync(tempPlanPath, publicPlanPath);
        }
        if (!fs.existsSync(publicPlanPath)) {
            return {
                success: false,
                error: 'video-plan.json not found. Run Generate first, then try Render.'
            };
        }

        const plan = JSON.parse(fs.readFileSync(publicPlanPath, 'utf-8'));
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const outputFile = path.join(OUTPUT_PATH, `video-${timestamp}.mp4`);

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('render-progress', { percent: 2, message: 'Starting FFmpeg GPU render...' });
        }

        const { renderWithFFmpeg } = require('./src/ffmpeg-renderer');
        const result = await renderWithFFmpeg(plan, {
            publicDir: PUBLIC_PATH,
            outputPath: outputFile,
            progressCallback: (progress) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('render-progress', progress);
                }
            }
        });

        if (result.success && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('render-progress', { percent: 100, message: 'Render complete!' });
        }

        return result;

    } catch (error) {
        const errText = (() => {
            if (!error) return 'Unknown FFmpeg error';
            if (typeof error === 'string') return error;
            if (error instanceof Error) return error.stack || error.message || String(error);
            try { return JSON.stringify(error); } catch { return String(error); }
        })();
        if (errText.includes('Cancelled')) {
            console.log('⛔ FFmpeg render cancelled by user');
            return { success: false, error: 'Cancelled' };
        }
        console.error('❌ FFmpeg render error:', errText);
        return { success: false, error: errText };
    }
});

// ========================================
// WebGL2 Compositor Engine - Export IPC
// ========================================

const WEBGL_FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmg\\bin\\ffmpeg.exe';

// NVENC availability cache (shared with ffmpeg-renderer if loaded)
let _webglNvencAvailable = null;

async function probeNvencForWebGL() {
    if (_webglNvencAvailable !== null) return _webglNvencAvailable;
    try {
        await new Promise((resolve, reject) => {
            const { execFile } = require('child_process');
            execFile(WEBGL_FFMPEG_PATH, [
                '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1',
                '-c:v', 'h264_nvenc', '-preset', 'p4',
                '-f', 'null', '-'
            ], { timeout: 10000 }, (err) => {
                if (err) reject(err); else resolve();
            });
        });
        _webglNvencAvailable = true;
        console.log('[WebGL Export] NVENC GPU encoder available');
    } catch {
        _webglNvencAvailable = false;
        console.log('[WebGL Export] NVENC not available, will use CPU (libx264)');
    }
    return _webglNvencAvailable;
}

// State for the active WebGL export
let _webglExport = null;

ipcMain.handle('start-webgl-export', async (event, options) => {
    try {
        const { width, height, fps, totalFrames } = options;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const videoFile = path.join(TEMP_PATH, `webgl-video-${timestamp}.mp4`);
        const outputFile = path.join(OUTPUT_PATH, `video-${timestamp}.mp4`);

        // Ensure output dirs exist
        if (!fs.existsSync(OUTPUT_PATH)) fs.mkdirSync(OUTPUT_PATH, { recursive: true });
        if (!fs.existsSync(TEMP_PATH)) fs.mkdirSync(TEMP_PATH, { recursive: true });

        // Probe NVENC
        const useGpu = await probeNvencForWebGL();
        const encArgs = useGpu
            ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '18M', '-maxrate:v', '24M', '-bufsize:v', '48M']
            : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '22'];

        console.log(`[WebGL Export] Starting: ${width}x${height} @ ${fps}fps, ${totalFrames} frames, encoder: ${useGpu ? 'NVENC' : 'libx264'}`);

        const ffmpegProc = spawn(WEBGL_FFMPEG_PATH, [
            '-y',
            '-f', 'rawvideo',
            '-pixel_format', 'rgba',
            '-video_size', `${width}x${height}`,
            '-framerate', String(fps),
            '-i', 'pipe:0',
            ...encArgs,
            '-pix_fmt', 'yuv420p',
            '-an',  // No audio (muxed later)
            videoFile
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        let ffmpegStderr = '';
        ffmpegProc.stderr.on('data', (data) => {
            ffmpegStderr += data.toString();
        });

        _webglExport = {
            proc: ffmpegProc,
            videoFile,
            outputFile,
            totalFrames,
            width, height, fps,
            stderr: ffmpegStderr,
            framesWritten: 0,
            bytesWritten: 0,
            lastLogTime: Date.now(),
            lastLogFrames: 0,
            expectedFrameSize: width * height * 4,
        };

        return { success: true, videoFile, outputFile };
    } catch (err) {
        console.error('[WebGL Export] start error:', err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('export-frame', async (event, frameBuffer) => {
    const exp = _webglExport;
    if (!exp || !exp.proc || exp.proc.killed) {
        return { success: false, error: 'No active export process' };
    }

    try {
        const buf = Buffer.from(frameBuffer);
        const canWrite = exp.proc.stdin.write(buf);
        exp.framesWritten++;
        if (!canWrite) {
            // Wait for drain before accepting more frames (backpressure)
            await new Promise(resolve => exp.proc.stdin.once('drain', resolve));
        }
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('export-frames-batch', async (event, batchPayload) => {
    const exp = _webglExport;
    if (!exp || !exp.proc || exp.proc.killed) {
        return { success: false, error: 'No active export process' };
    }

    try {
        const { frames } = batchPayload; // Array of { frameIndex, buffer }
        if (!frames || !frames.length) {
            return { success: true, written: 0 };
        }

        // Detect out-of-order (renderer guarantees order, but log if violated)
        for (let i = 1; i < frames.length; i++) {
            if (frames[i].frameIndex <= frames[i - 1].frameIndex) {
                console.warn(`[WebGL Export] Out-of-order batch: frame ${frames[i].frameIndex} after ${frames[i - 1].frameIndex}`);
            }
        }

        // Concatenate all frame buffers into a single Buffer for one stdin.write()
        const totalSize = frames.length * exp.expectedFrameSize;
        const combined = Buffer.allocUnsafe(totalSize);
        let offset = 0;
        for (const entry of frames) {
            const src = Buffer.from(entry.buffer);
            if (src.length !== exp.expectedFrameSize) {
                console.warn(`[WebGL Export] Frame ${entry.frameIndex} size mismatch: ${src.length} vs expected ${exp.expectedFrameSize}`);
            }
            src.copy(combined, offset);
            offset += src.length;
        }

        // Single write for the whole batch
        const canWrite = exp.proc.stdin.write(combined);
        exp.framesWritten += frames.length;
        exp.bytesWritten += offset;

        // Backpressure: wait for FFmpeg to drain before returning
        if (!canWrite) {
            await new Promise(resolve => exp.proc.stdin.once('drain', resolve));
        }

        // Periodic logging (~every second)
        const now = Date.now();
        if (now - exp.lastLogTime >= 1000) {
            const elapsed = (now - exp.lastLogTime) / 1000;
            const recentFrames = exp.framesWritten - exp.lastLogFrames;
            const fps = (recentFrames / elapsed).toFixed(1);
            const totalMB = (exp.bytesWritten / (1024 * 1024)).toFixed(0);
            console.log(`[WebGL Export] ${exp.framesWritten}/${exp.totalFrames} frames | ${fps} fps recent | ${totalMB} MB written`);
            exp.lastLogTime = now;
            exp.lastLogFrames = exp.framesWritten;
        }

        return { success: true, written: frames.length };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('finish-webgl-export', async () => {
    const exp = _webglExport;
    if (!exp || !exp.proc) {
        return { success: false, error: 'No active export process' };
    }

    try {
        // Close FFmpeg stdin to signal end of input
        exp.proc.stdin.end();

        // Wait for FFmpeg to finish encoding
        const exitCode = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                try { exp.proc.kill('SIGTERM'); } catch (_) {}
                reject(new Error('FFmpeg timeout'));
            }, 120000); // 2 minute timeout

            exp.proc.on('close', (code) => {
                clearTimeout(timeout);
                resolve(code);
            });
            exp.proc.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });

        if (exitCode !== 0) {
            throw new Error(`FFmpeg exited with code ${exitCode}`);
        }

        console.log(`[WebGL Export] Video encoded: ${exp.videoFile} (${exp.framesWritten} frames)`);

        // Mux audio if available
        const finalOutput = await _webglMuxAudio(exp);

        _webglExport = null;
        return { success: true, outputPath: finalOutput };

    } catch (err) {
        console.error('[WebGL Export] finish error:', err.message);
        _webglExport = null;
        return { success: false, error: err.message };
    }
});

ipcMain.handle('cancel-webgl-export', async () => {
    if (_webglExport && _webglExport.proc) {
        try {
            if (process.platform === 'win32' && _webglExport.proc.pid) {
                exec(`taskkill /pid ${_webglExport.proc.pid} /f /t`, () => {});
            } else {
                _webglExport.proc.kill('SIGTERM');
            }
        } catch (_) {}
        _webglExport = null;
    }
    return { success: true };
});

/**
 * Mux the WebGL-rendered video with the project's audio track.
 * Returns the final output file path.
 */
async function _webglMuxAudio(exp) {
    // Find the audio file
    const planPath = path.join(PUBLIC_PATH, 'video-plan.json');
    let audioFile = null;

    if (fs.existsSync(planPath)) {
        try {
            const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
            if (plan.audio) {
                // Check public, then temp, then input
                for (const dir of [PUBLIC_PATH, TEMP_PATH, INPUT_PATH]) {
                    const candidate = path.join(dir, plan.audio);
                    if (fs.existsSync(candidate)) {
                        audioFile = candidate;
                        break;
                    }
                }
            }
        } catch (_) {}
    }

    if (!audioFile) {
        // No audio — just rename video file to output
        const dest = exp.outputFile;
        fs.copyFileSync(exp.videoFile, dest);
        console.log('[WebGL Export] No audio to mux, video only:', dest);
        return dest;
    }

    // Mux video + audio using FFmpeg (with optional audio trim for in/out points)
    const audioInputArgs = [];
    if (exp.audioTrimStartSec != null && exp.audioTrimStartSec > 0) {
        audioInputArgs.push('-ss', String(exp.audioTrimStartSec));
    }
    if (exp.audioTrimEndSec != null) {
        audioInputArgs.push('-to', String(exp.audioTrimEndSec));
    }
    audioInputArgs.push('-i', audioFile);

    const trimLog = (exp.audioTrimStartSec || exp.audioTrimEndSec) ?
        ` (trim: ${exp.audioTrimStartSec || 0}s → ${exp.audioTrimEndSec || 'end'})` : '';
    console.log('[WebGL Export] Muxing audio:', audioFile + trimLog);

    return new Promise((resolve, reject) => {
        const muxProc = spawn(WEBGL_FFMPEG_PATH, [
            '-y',
            '-i', exp.videoFile,
            ...audioInputArgs,
            '-c:v', 'copy',        // No re-encode of video
            '-c:a', 'aac', '-b:a', '192k',
            '-shortest',
            '-movflags', '+faststart',
            exp.outputFile
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        muxProc.on('close', (code) => {
            // Clean up temp video file
            try { fs.unlinkSync(exp.videoFile); } catch (_) {}

            if (code === 0) {
                console.log('[WebGL Export] Final output:', exp.outputFile);
                resolve(exp.outputFile);
            } else {
                // Fallback: use video-only file
                fs.copyFileSync(exp.videoFile, exp.outputFile);
                resolve(exp.outputFile);
            }
        });

        muxProc.on('error', (err) => {
            // Fallback: use video-only
            try { fs.copyFileSync(exp.videoFile, exp.outputFile); } catch (_) {}
            resolve(exp.outputFile);
        });
    });
}

// ========================================
// V2 GPU-Native Export — IPC Handlers
// ========================================
// Reason codes for V2 fallback
const V2_REASONS = {
    DISABLED_FLAG: 'V2_DISABLED_FLAG',
    NOT_IMPLEMENTED: 'V2_NOT_IMPLEMENTED',
    ANGLE_NOT_D3D11: 'ANGLE_NOT_D3D11',
    EGL_EXT_MISSING: 'EGL_EXT_MISSING',
    PBUFFER_CREATE_FAIL: 'PBUFFER_CREATE_FAIL',
    NVENC_INIT_FAIL: 'NVENC_INIT_FAIL',
    ENCODE_RUNTIME_FAIL: 'ENCODE_RUNTIME_FAIL',
};

// Try to load native addon (Phase 1+ builds it)
let _gpuExportAddon = null;
try {
    _gpuExportAddon = require('./src/native/gpu-export/build/Release/gpu_export.node');
    console.log('[V2] Native addon loaded');
} catch (_) {
    // Expected until Phase 1 is built — silent fallback
}

ipcMain.handle('v2-probe', async () => {
    if (process.env.EXPORT_V2 === '0') {
        console.log('[V2] Probe: DISABLED by EXPORT_V2=0');
        return { ok: false, reason: V2_REASONS.DISABLED_FLAG };
    }
    if (!_gpuExportAddon) {
        console.log('[V2] Probe: addon not loaded (V2_NOT_IMPLEMENTED)');
        return { ok: false, reason: V2_REASONS.NOT_IMPLEMENTED };
    }
    try {
        const result = _gpuExportAddon.probeAngleD3D11();
        if (result.ok) {
            console.log('[V2] Probe SUCCESS:', JSON.stringify(result.details, null, 2));
        } else {
            console.log(`[V2] Probe FAILED: ${result.reason} — ${result.error || 'no details'}`);
        }
        return result;
    } catch (err) {
        console.error('[V2] Probe EXCEPTION:', err.message);
        return { ok: false, reason: V2_REASONS.ANGLE_NOT_D3D11, error: err.message };
    }
});

// V2 Target management — D3D11 shared textures + EGL pbuffer surfaces
ipcMain.handle('v2-create-targets', async (event, opts) => {
    if (!_gpuExportAddon) return { ok: false, reason: 'addon not loaded' };
    try {
        const { width, height, count } = opts;
        const n = count || 3;
        const texResult = _gpuExportAddon.createSharedTextures(width, height, n);
        if (!texResult.ok) {
            console.error('[V2] createSharedTextures failed');
            return { ok: false, reason: 'createSharedTextures failed' };
        }
        const pbufResult = _gpuExportAddon.createPbufferSurfaces(n);
        if (!pbufResult.ok) {
            console.error('[V2] createPbufferSurfaces failed');
            _gpuExportAddon.destroySharedTextures();
            return { ok: false, reason: 'createPbufferSurfaces failed' };
        }
        console.log(`[V2] Created ${n} targets (${width}x${height})`);
        return { ok: true, count: n, width, height };
    } catch (err) {
        console.error('[V2] createTargets error:', err.message);
        return { ok: false, reason: err.message };
    }
});

ipcMain.handle('v2-begin-frame', async (event, targetIndex) => {
    if (!_gpuExportAddon) return false;
    return _gpuExportAddon.makePbufferCurrent(targetIndex);
});

ipcMain.handle('v2-end-frame', async (event, targetIndex) => {
    if (!_gpuExportAddon) return false;
    return _gpuExportAddon.restoreDefaultSurface();
});

ipcMain.handle('v2-destroy-targets', async () => {
    if (!_gpuExportAddon) return;
    try {
        _gpuExportAddon.destroyPbufferSurfaces();
        _gpuExportAddon.destroySharedTextures();
        console.log('[V2] Destroyed all targets');
    } catch (err) {
        console.error('[V2] destroyTargets error:', err.message);
    }
});

// V2 Encoder — FFmpeg rawvideo input (RGBA from readPixels or BGRA from D3D readback)
ipcMain.handle('v2-init-encoder', async (event, opts) => {
    try {
        const { width, height, fps, totalFrames, pixelFormat } = opts;
        const fmt = pixelFormat || 'rgba';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const videoFile = path.join(TEMP_PATH, `v2-video-${timestamp}.mp4`);
        const outputFile = path.join(OUTPUT_PATH, `video-${timestamp}.mp4`);

        if (!fs.existsSync(OUTPUT_PATH)) fs.mkdirSync(OUTPUT_PATH, { recursive: true });
        if (!fs.existsSync(TEMP_PATH)) fs.mkdirSync(TEMP_PATH, { recursive: true });

        const useGpu = await probeNvencForWebGL();
        const encArgs = useGpu
            ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '18M', '-maxrate:v', '24M', '-bufsize:v', '48M']
            : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '22'];

        console.log(`[V2 Export] Starting: ${width}x${height} @ ${fps}fps, ${totalFrames} frames, format: ${fmt}, encoder: ${useGpu ? 'NVENC' : 'libx264'}`);

        const ffmpegProc = spawn(WEBGL_FFMPEG_PATH, [
            '-y',
            '-f', 'rawvideo',
            '-pixel_format', fmt,
            '-video_size', `${width}x${height}`,
            '-framerate', String(fps),
            '-i', 'pipe:0',
            ...encArgs,
            '-pix_fmt', 'yuv420p',
            '-an',
            videoFile
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        let ffmpegStderr = '';
        ffmpegProc.stderr.on('data', (data) => {
            ffmpegStderr += data.toString();
        });

        _webglExport = {
            proc: ffmpegProc,
            videoFile,
            outputFile,
            totalFrames,
            width, height, fps,
            stderr: ffmpegStderr,
            framesWritten: 0,
            bytesWritten: 0,
            lastLogTime: Date.now(),
            lastLogFrames: 0,
            expectedFrameSize: width * height * 4,
            isV2: true,
        };

        return { ok: true, videoFile, outputFile };
    } catch (err) {
        console.error('[V2 Export] init error:', err.message);
        return { ok: false, reason: err.message };
    }
});

// V2 Encode frame — accepts raw pixel buffer from renderer OR D3D11 readback
// opts.frameBuffer: ArrayBuffer from readPixels (RGBA) — used when shared texture redirect not available
// opts.targetIndex: D3D11 readback from shared texture — used when renderer→shared texture works
ipcMain.handle('v2-encode-frame', async (event, opts) => {
    const exp = _webglExport;
    if (!exp || !exp.proc || exp.proc.killed) {
        return { ok: false, error: 'No active export process' };
    }

    try {
        let buf;
        if (opts.frameBuffer) {
            // Raw pixel data from renderer readPixels
            buf = Buffer.from(opts.frameBuffer);
        } else if (opts.targetIndex !== undefined && _gpuExportAddon) {
            // D3D11 readback from shared texture
            buf = _gpuExportAddon.readTextureToBuffer(opts.targetIndex);
            if (!buf) {
                return { ok: false, error: `readTextureToBuffer(${opts.targetIndex}) returned null` };
            }
        } else {
            return { ok: false, error: 'No frame data: provide frameBuffer or targetIndex' };
        }

        // Debug: log center pixel of first few frames
        if (exp.framesWritten < 3) {
            const cx = Math.floor(exp.width / 2), cy = Math.floor(exp.height / 2);
            const off = (cy * exp.width + cx) * 4;
            console.log(`[V2 Export] Frame ${opts.frameIndex || exp.framesWritten} center RGBA=(${buf[off]},${buf[off+1]},${buf[off+2]},${buf[off+3]})`);
        }

        const canWrite = exp.proc.stdin.write(buf);
        exp.framesWritten++;
        exp.bytesWritten += buf.length;

        if (!canWrite) {
            await new Promise(resolve => exp.proc.stdin.once('drain', resolve));
        }

        // Periodic logging
        const now = Date.now();
        if (now - exp.lastLogTime >= 1000) {
            const elapsed = (now - exp.lastLogTime) / 1000;
            const recentFrames = exp.framesWritten - exp.lastLogFrames;
            const currentFps = (recentFrames / elapsed).toFixed(1);
            const totalMB = (exp.bytesWritten / (1024 * 1024)).toFixed(0);
            console.log(`[V2 Export] ${exp.framesWritten}/${exp.totalFrames} frames | ${currentFps} fps | ${totalMB} MB`);
            exp.lastLogTime = now;
            exp.lastLogFrames = exp.framesWritten;
        }

        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// V2 Flush — close FFmpeg stdin, wait for exit, mux audio
ipcMain.handle('v2-flush-encoder', async () => {
    const exp = _webglExport;
    if (!exp || !exp.proc) {
        return { ok: false, error: 'No active export process' };
    }

    try {
        exp.proc.stdin.end();

        const exitCode = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                try { exp.proc.kill('SIGTERM'); } catch (_) {}
                reject(new Error('FFmpeg timeout'));
            }, 120000);

            exp.proc.on('close', (code) => {
                clearTimeout(timeout);
                resolve(code);
            });
            exp.proc.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });

        if (exitCode !== 0) {
            throw new Error(`FFmpeg exited with code ${exitCode}`);
        }

        console.log(`[V2 Export] Video encoded: ${exp.videoFile} (${exp.framesWritten} frames)`);

        const finalOutput = await _webglMuxAudio(exp);

        _webglExport = null;
        return { ok: true, outputPath: finalOutput };
    } catch (err) {
        console.error('[V2 Export] flush error:', err.message);
        _webglExport = null;
        return { ok: false, error: err.message };
    }
});

// V2 Close — destroy targets + cleanup
ipcMain.handle('v2-close-encoder', async () => {
    if (_gpuExportAddon) {
        try {
            _gpuExportAddon.destroyPbufferSurfaces();
            _gpuExportAddon.destroySharedTextures();
            console.log('[V2] Encoder closed, targets destroyed');
        } catch (err) {
            console.error('[V2] close error:', err.message);
        }
    }
    return { ok: true };
});

// ========================================
// Native D3D11 + NVENC Export Engine
// ========================================
let _nativeExporterAddon = null;
try {
    _nativeExporterAddon = require('./src/native/native-exporter/build/Release/native_exporter.node');
    console.log('[NativeExport] Addon loaded');
} catch (_) {
    // Expected until addon is built
}

ipcMain.handle('native-export-probe', async () => {
    if (!_nativeExporterAddon) {
        return { ok: false, reason: 'Native exporter addon not loaded' };
    }
    try {
        return _nativeExporterAddon.probe();
    } catch (err) {
        console.error('[NativeExport] probe error:', err.message);
        return { ok: false, reason: err.message };
    }
});

ipcMain.handle('native-export-start', async (event, opts) => {
    if (!_nativeExporterAddon) {
        return { ok: false, reason: 'Native exporter addon not loaded' };
    }

    try {
        const { width, height, fps, totalFrames } = opts;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const h264File = path.join(TEMP_PATH, `native-${timestamp}.h264`);
        const videoFile = path.join(TEMP_PATH, `native-${timestamp}.mp4`);
        const outputFile = path.join(OUTPUT_PATH, `video-${timestamp}.mp4`);

        if (!fs.existsSync(OUTPUT_PATH)) fs.mkdirSync(OUTPUT_PATH, { recursive: true });
        if (!fs.existsSync(TEMP_PATH)) fs.mkdirSync(TEMP_PATH, { recursive: true });

        console.log(`[NativeExport] Starting: ${width}x${height} @ ${fps}fps, ${totalFrames} frames`);

        // 1. Encode synthetic frames → .h264
        const encResult = _nativeExporterAddon.encode({
            width, height, fps, totalFrames,
            bitrate: opts.bitrate || 18000000,
            maxBitrate: opts.maxBitrate || 24000000,
            gop: opts.gop || (fps * 2),
            bframes: opts.bframes !== undefined ? opts.bframes : 2,
            preset: opts.preset || 5,
            rc: opts.rc || 'vbr_hq',
            outputPath: h264File,
        });

        if (!encResult.ok) {
            console.error('[NativeExport] Encode failed:', encResult.reason);
            return encResult;
        }

        console.log(`[NativeExport] Encoded ${encResult.frames} frames in ${encResult.elapsed.toFixed(2)}s (${encResult.fps.toFixed(1)} fps)`);

        // 2. Wrap .h264 → .mp4 via FFmpeg (-c:v copy)
        await new Promise((resolve, reject) => {
            const wrapProc = spawn(WEBGL_FFMPEG_PATH, [
                '-y', '-r', String(fps),
                '-i', h264File,
                '-c:v', 'copy',
                '-movflags', '+faststart',
                videoFile
            ], { stdio: ['ignore', 'pipe', 'pipe'] });

            let wrapErr = '';
            wrapProc.stderr.on('data', d => { wrapErr += d.toString(); });
            wrapProc.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error(`FFmpeg wrap exit ${code}: ${wrapErr.slice(-200)}`));
            });
            wrapProc.on('error', reject);
        });

        // 3. Mux audio (reuse existing _webglMuxAudio pattern)
        const exp = { videoFile, outputFile, audioTrimStartSec: opts.audioTrimStartSec, audioTrimEndSec: opts.audioTrimEndSec };
        const finalOutput = await _webglMuxAudio(exp);

        // Clean up .h264 temp file
        try { fs.unlinkSync(h264File); } catch (_) {}

        console.log(`[NativeExport] Output: ${finalOutput}`);
        return { ok: true, outputPath: finalOutput, frames: encResult.frames, elapsed: encResult.elapsed, fps: encResult.fps };
    } catch (err) {
        console.error('[NativeExport] start error:', err.message);
        return { ok: false, reason: err.message };
    }
});

ipcMain.handle('native-compose-export', async (event, opts) => {
    if (!_nativeExporterAddon || !_nativeExporterAddon.composeAndEncode) {
        return { ok: false, reason: 'Native exporter addon not loaded or missing composeAndEncode' };
    }

    try {
        const { width, height, fps, totalFrames, layers } = opts;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const h264File = path.join(TEMP_PATH, `compose-${timestamp}.h264`);
        const videoFile = path.join(TEMP_PATH, `compose-${timestamp}.mp4`);
        const outputFile = path.join(OUTPUT_PATH, `compose-${timestamp}.mp4`);

        if (!fs.existsSync(OUTPUT_PATH)) fs.mkdirSync(OUTPUT_PATH, { recursive: true });
        if (!fs.existsSync(TEMP_PATH)) fs.mkdirSync(TEMP_PATH, { recursive: true });

        console.log(`[NativeCompose] Starting: ${width}x${height} @ ${fps}fps, ${totalFrames} frames, ${layers.length} layers`);
        // Log layer summary for debugging
        for (let i = 0; i < layers.length; i++) {
            const l = layers[i];
            console.log(`[NativeCompose]   layer[${i}] type=${l.type} frames=${l.startFrame}-${l.endFrame} track=${l.trackNum}${l.mediaPath ? ' path=' + l.mediaPath : ''}${l.seqDir ? ' seqDir=' + l.seqDir : ''}`);
        }

        const encResult = _nativeExporterAddon.composeAndEncode({
            width, height, fps, totalFrames, layers,
            outputPath: h264File,
            bitrate: opts.bitrate || 18000000,
            maxBitrate: opts.maxBitrate || 24000000,
            gop: opts.gop || (fps * 2),
            bframes: opts.bframes !== undefined ? opts.bframes : 2,
            preset: opts.preset || 5,
            rc: opts.rc || 'vbr_hq',
        });

        if (!encResult.ok) {
            console.error('[NativeCompose] Failed:', encResult.reason);
            return encResult;
        }

        console.log(`[NativeCompose] Encoded ${encResult.frames} frames in ${encResult.elapsed.toFixed(2)}s (${encResult.fps.toFixed(1)} fps)`);

        // Wrap .h264 → .mp4
        await new Promise((resolve, reject) => {
            const wrapProc = spawn(WEBGL_FFMPEG_PATH, [
                '-y', '-r', String(fps),
                '-i', h264File,
                '-c:v', 'copy',
                '-movflags', '+faststart',
                videoFile
            ], { stdio: ['ignore', 'pipe', 'pipe'] });
            let wrapErr = '';
            wrapProc.stderr.on('data', d => { wrapErr += d.toString(); });
            wrapProc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg wrap exit ${code}: ${wrapErr.slice(-200)}`)));
            wrapProc.on('error', reject);
        });

        // Mux audio (with in/out trim if specified)
        const finalOutput = await _webglMuxAudio({
            videoFile, outputFile,
            audioTrimStartSec: opts.audioTrimStartSec,
            audioTrimEndSec: opts.audioTrimEndSec,
        });

        try { fs.unlinkSync(h264File); } catch (_) {}

        console.log(`[NativeCompose] Output: ${finalOutput}`);
        return { ok: true, outputPath: finalOutput, frames: encResult.frames, elapsed: encResult.elapsed, fps: encResult.fps };
    } catch (err) {
        console.error('[NativeCompose] Error:', err.message);
        return { ok: false, reason: err.message };
    }
});

ipcMain.handle('native-export-cancel', async () => {
    if (_nativeExporterAddon) {
        try { _nativeExporterAddon.cancel(); } catch (_) {}
    }
    return { ok: true };
});

ipcMain.handle('pre-render-mgs-png', async (event, opts) => {
    try {
        const { renderMGsToPNG } = require('./src/mg-png-renderer');
        const cacheDir = path.join(TEMP_PATH, 'mg-png-cache');
        const result = await renderMGsToPNG(opts, cacheDir, (pct, msg) => {
            console.log(`[PreRenderMG] ${pct}% ${msg}`);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('export-progress', { percent: pct, message: msg });
            }
        });
        return { ok: true, layers: result.layers };
    } catch (err) {
        console.error('[PreRenderMG] Error:', err.message);
        return { ok: false, reason: err.message };
    }
});

// Open output folder
ipcMain.handle('open-output-folder', async () => {
    shell.openPath(OUTPUT_PATH);
});

// Open current project's logs folder
ipcMain.handle('open-project-logs', async () => {
    const logsDir = ensureLogsDir(PROJECT_DIR);
    await shell.openPath(logsDir);
    return { success: true, logsDir };
});

// Tail latest project log in a live PowerShell window
ipcMain.handle('tail-project-logs', async () => {
    return tailProjectLogsLive(PROJECT_DIR);
});

// Get current log file path (for troubleshooting UI)
ipcMain.handle('get-current-log-file', async () => {
    return {
        projectDir: PROJECT_DIR,
        logsDir: getLogsDir(PROJECT_DIR),
        logFile: CURRENT_LOG_FILE,
    };
});

// Open file in default app
ipcMain.handle('open-file', async (event, filePath) => {
    shell.openPath(filePath);
});

// Select folder dialog
ipcMain.handle('select-folder', async (event, title) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: title || 'Select folder',
        properties: ['openDirectory', 'createDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
    }
    return null;
});

// Startup chooser actions (custom in-app startup window)
ipcMain.handle('startup-create-project', async () => {
    const result = await dialog.showOpenDialog(startupWindow || null, {
        title: 'Choose folder for new project',
        properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { success: false, cancelled: true };
    const projectPath = result.filePaths[0];
    resolveStartupChoice(projectPath);
    return { success: true, projectDir: projectPath };
});

ipcMain.handle('startup-open-project-folder', async () => {
    const result = await dialog.showOpenDialog(startupWindow || null, {
        title: 'Open existing project folder',
        properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { success: false, cancelled: true };
    const projectPath = result.filePaths[0];
    resolveStartupChoice(projectPath);
    return { success: true, projectDir: projectPath };
});

ipcMain.handle('startup-open-project-file', async () => {
    const result = await dialog.showOpenDialog(startupWindow || null, {
        title: 'Open .fvp project file',
        properties: ['openFile'],
        filters: [{ name: 'Project Files', extensions: ['fvp'] }]
    });
    if (result.canceled || !result.filePaths.length) return { success: false, cancelled: true };
    const fvpPath = result.filePaths[0];
    const projectPath = path.dirname(fvpPath);
    resolveStartupChoice(projectPath);
    return { success: true, projectDir: projectPath, projectFile: fvpPath };
});

ipcMain.handle('startup-cancel', async () => {
    resolveStartupChoice(null);
    return { success: true, cancelled: true };
});

// Select file dialog
ipcMain.handle('select-file', async (event, options) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [
            { name: 'Audio Files', extensions: ['mp3', 'wav'] }
        ],
        ...options
    });

    if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
    }
    return null;
});

// Get file URL for video playback
ipcMain.handle('get-file-url', async (event, filePath) => {
    // Convert file path to file:// URL
    if (fs.existsSync(filePath)) {
        // Use URL constructor to handle encoding of spaces and special chars
        const fileUrl = new URL(`file://${filePath.replace(/\\/g, '/')}`);
        return fileUrl.href;
    }
    return null;
});

// Show OS notification
ipcMain.handle('show-notification', async (event, title, body) => {
    if (Notification.isSupported()) {
        const n = new Notification({ title, body, silent: false });
        n.show();
    }
});

// Get SFX file path for preview playback
ipcMain.handle('get-sfx-path', async (event, filename) => {
    const sfxPath = path.join(__dirname, 'assets', 'sfx', filename);
    if (fs.existsSync(sfxPath)) {
        const fileUrl = new URL(`file://${sfxPath.replace(/\\/g, '/')}`);
        return fileUrl.href;
    }
    // Fallback: check project's public folder
    const pubPath = path.join(PUBLIC_PATH, filename);
    if (fs.existsSync(pubPath)) {
        const fileUrl = new URL(`file://${pubPath.replace(/\\/g, '/')}`);
        return fileUrl.href;
    }
    return null;
});

// Scan assets/overlays/ folder for available overlay files
ipcMain.handle('scan-overlays', async () => {
    const overlaysDir = path.join(__dirname, 'assets', 'overlays');
    if (!fs.existsSync(overlaysDir)) return [];

    const supportedExts = new Set(['.mp4', '.webm', '.mov', '.jpg', '.jpeg', '.png', '.gif']);
    const files = fs.readdirSync(overlaysDir).filter(f => {
        const ext = path.extname(f).toLowerCase();
        return supportedExts.has(ext) && !f.startsWith('.');
    });

    return files.map(f => {
        const ext = path.extname(f).toLowerCase();
        const name = path.basename(f, path.extname(f));
        const isVideo = ['.mp4', '.webm', '.mov'].includes(ext);
        const fullPath = path.join(overlaysDir, f);
        const stat = fs.statSync(fullPath);
        return {
            filename: f,
            name: name,
            ext: ext,
            mediaType: isVideo ? 'video' : 'image',
            size: stat.size,
            path: fullPath,
        };
    });
});

// Get overlay file URL for preview playback
ipcMain.handle('get-overlay-url', async (event, filename) => {
    const overlayPath = path.join(__dirname, 'assets', 'overlays', filename);
    if (fs.existsSync(overlayPath)) {
        const fileUrl = new URL(`file://${overlayPath.replace(/\\/g, '/')}`);
        return fileUrl.href;
    }
    return null;
});

// Scan assets/backgrounds/ folder for available background pattern files
ipcMain.handle('scan-backgrounds', async () => {
    const bgDir = path.join(__dirname, 'assets', 'backgrounds');
    if (!fs.existsSync(bgDir)) {
        fs.mkdirSync(bgDir, { recursive: true });
        return [];
    }

    const supportedExts = new Set(['.mp4', '.webm', '.mov', '.jpg', '.jpeg', '.png', '.gif']);
    const files = fs.readdirSync(bgDir).filter(f => {
        const ext = path.extname(f).toLowerCase();
        return supportedExts.has(ext) && !f.startsWith('.');
    });

    return files.map(f => {
        const ext = path.extname(f).toLowerCase();
        const name = path.basename(f, path.extname(f));
        const isVideo = ['.mp4', '.webm', '.mov'].includes(ext);
        const fullPath = path.join(bgDir, f);
        const stat = fs.statSync(fullPath);
        return {
            filename: f,
            name: name,
            ext: ext,
            mediaType: isVideo ? 'video' : 'image',
            size: stat.size,
            path: fullPath,
        };
    });
});

// Get background file URL for preview
ipcMain.handle('get-background-url', async (event, filename) => {
    const bgPath = path.join(__dirname, 'assets', 'backgrounds', filename);
    if (fs.existsSync(bgPath)) {
        const fileUrl = new URL(`file://${bgPath.replace(/\\/g, '/')}`);
        return fileUrl.href;
    }
    return null;
});

// ========================================
// Multi-Instance / Project Management
// ========================================

// Get info about the current project
ipcMain.handle('get-project-info', async () => {
    return {
        projectDir: PROJECT_DIR,
        projectName: PROJECT_NAME,
        projectFile: getProjectFilePath(),
        appRoot: APP_ROOT,
        isDefaultProject: PROJECT_DIR === APP_ROOT
    };
});

// Launch a new instance with a new project folder
// options: { projectName, location } — if provided, creates named subfolder
ipcMain.handle('launch-new-instance', async (event, options) => {
    let projectPath;

    if (options && options.projectName && options.location) {
        // Create named subfolder at chosen location
        projectPath = path.join(options.location, options.projectName);
        if (!fs.existsSync(projectPath)) {
            fs.mkdirSync(projectPath, { recursive: true });
        }
    } else {
        // Legacy: just pick a folder
        const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Choose location for new project',
            properties: ['openDirectory', 'createDirectory']
        });
        if (result.canceled || !result.filePaths.length) return { success: false, cancelled: true };
        projectPath = result.filePaths[0];
    }

    _spawnNewInstance(projectPath);
    return { success: true, projectDir: projectPath };
});

// Open an existing project folder in a new instance
ipcMain.handle('open-existing-project', async () => {
    const projectPath = await promptForExistingProjectPath(mainWindow);
    if (!projectPath) return { success: false, cancelled: true };

    _spawnNewInstance(projectPath);
    return { success: true, projectDir: projectPath };
});

// Open existing project by selecting a folder (no mode prompt)
ipcMain.handle('open-existing-project-folder', async () => {
    const folderResult = await dialog.showOpenDialog(mainWindow, {
        title: 'Open existing project folder',
        properties: ['openDirectory']
    });
    if (folderResult.canceled || !folderResult.filePaths.length) return { success: false, cancelled: true };

    const projectPath = folderResult.filePaths[0];
    _spawnNewInstance(projectPath);
    return { success: true, projectDir: projectPath };
});

// Open existing project by selecting a .fvp file (no mode prompt)
ipcMain.handle('open-existing-project-file', async () => {
    const fileResult = await dialog.showOpenDialog(mainWindow, {
        title: 'Open .fvp project file',
        properties: ['openFile'],
        filters: [{ name: 'Project Files', extensions: ['fvp'] }]
    });
    if (fileResult.canceled || !fileResult.filePaths.length) return { success: false, cancelled: true };

    const projectFile = fileResult.filePaths[0];
    const projectPath = path.dirname(projectFile);
    _spawnNewInstance(projectPath);
    return { success: true, projectDir: projectPath, projectFile };
});

function _spawnNewInstance(projectPath) {
    // Spawn a new Electron process with --project= pointing to the chosen folder
    const electronPath = process.argv[0]; // path to electron executable
    const appPath = APP_ROOT;
    const args = [appPath, `--project=${projectPath}`];
    // Also forward --dev flag if active
    if (process.argv.includes('--dev')) args.push('--dev');

    const child = spawn(electronPath, args, {
        detached: true,
        stdio: 'ignore',
        cwd: APP_ROOT
    });
    child.unref();
    console.log(`🚀 Launched new instance for project: ${projectPath}`);
}

// ========================================
// Desktop Shortcut & Start Menu
// ========================================
ipcMain.handle('create-desktop-shortcut', async () => {
    if (process.platform !== 'win32') return { success: false, error: 'Windows only' };
    try {
        const desktopDir = path.join(require('os').homedir(), 'Desktop');
        const shortcutPath = path.join(desktopDir, 'YTA Empire 2.lnk');
        const electronExe = process.execPath;
        const icon = getShortcutIconPath();

        // Use PowerShell to create a .lnk shortcut
        const ps = `
$ws = New-Object -ComObject WScript.Shell;
$sc = $ws.CreateShortcut('${shortcutPath.replace(/'/g, "''")}');
$sc.TargetPath = '${electronExe.replace(/'/g, "''")}';
$sc.Arguments = '"${APP_ROOT.replace(/'/g, "''")}"';
$sc.WorkingDirectory = '${APP_ROOT.replace(/'/g, "''")}';
$sc.IconLocation = '${icon.replace(/'/g, "''")}';
$sc.Description = 'YTA Empire 2 - AI Video Generator';
$sc.Save();
        `.trim();

        execSync(`powershell -Command "${ps.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { stdio: 'ignore' });
        console.log('✅ Desktop shortcut created:', shortcutPath);
        return { success: true, path: shortcutPath };
    } catch (e) {
        console.error('❌ Failed to create shortcut:', e.message);
        return { success: false, error: e.message };
    }
});

// ========================================
// .fvp File Association (Windows)
// ========================================
// Registers .fvp files to open with this app (HKCU — no admin needed)
function registerFvpFileAssociation() {
    if (process.platform !== 'win32') return { success: false, error: 'Only supported on Windows' };

    try {
        const electronExe = process.execPath; // Full path to electron.exe
        const appDir = APP_ROOT;
        // Icon: use custom .ico if available, otherwise electron.exe
        const iconValue = getShortcutIconPath();

        // Write a .reg file and import it (most reliable way to handle Windows registry quoting)
        // In .reg files: backslash = \\, inner quotes = \"
        const regEsc = (p) => p.replace(/\\/g, '\\\\');
        const regQ = (p) => `\\\"${regEsc(p)}\\\"`;  // Quoted path for .reg value
        const openCmd = `${regQ(electronExe)} ${regQ(appDir)} \\\"%1\\\"`;
        const regContent = [
            'Windows Registry Editor Version 5.00',
            '',
            '[HKEY_CURRENT_USER\\Software\\Classes\\.fvp]',
            '@="FacelessVideoProject"',
            '',
            '[HKEY_CURRENT_USER\\Software\\Classes\\FacelessVideoProject]',
            '@="YTA Empire 2 Project"',
            '',
            '[HKEY_CURRENT_USER\\Software\\Classes\\FacelessVideoProject\\DefaultIcon]',
            `@="${regEsc(iconValue)}"`,
            '',
            '[HKEY_CURRENT_USER\\Software\\Classes\\FacelessVideoProject\\shell\\open\\command]',
            `@="${openCmd}"`,
            ''
        ].join('\r\n');

        const regFile = path.join(APP_ROOT, 'temp', 'fvp-association.reg');
        if (!fs.existsSync(path.dirname(regFile))) fs.mkdirSync(path.dirname(regFile), { recursive: true });
        // .reg files need UTF-16LE BOM to import correctly
        const bom = Buffer.from([0xFF, 0xFE]);
        const content = Buffer.from(regContent, 'utf16le');
        fs.writeFileSync(regFile, Buffer.concat([bom, content]));
        execSync(`reg import "${regFile}"`, { stdio: 'ignore' });
        try { fs.unlinkSync(regFile); } catch (_) {} // Clean up

        console.log('✅ .fvp file association registered');
        return { success: true };
    } catch (e) {
        console.error('❌ Failed to register .fvp file association:', e.message);
        return { success: false, error: e.message };
    }
}

ipcMain.handle('register-fvp-association', async () => {
    return registerFvpFileAssociation();
});

// Auto-register file association + create desktop shortcut on first launch
const fvpRegisteredFlag = path.join(APP_ROOT, '.fvp-registered');
if (process.platform === 'win32' && !fs.existsSync(fvpRegisteredFlag)) {
    try {
        registerFvpFileAssociation();
        // Auto-create desktop shortcut
        const desktopDir = path.join(require('os').homedir(), 'Desktop');
        const shortcutPath = path.join(desktopDir, 'YTA Empire 2.lnk');
        if (!fs.existsSync(shortcutPath)) {
            const electronExe = process.execPath;
            const icon = getShortcutIconPath();
            const ps = `$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut('${shortcutPath.replace(/'/g, "''")}'); $sc.TargetPath = '${electronExe.replace(/'/g, "''")}'; $sc.Arguments = '""${APP_ROOT.replace(/'/g, "''")}""'; $sc.WorkingDirectory = '${APP_ROOT.replace(/'/g, "''")}'; $sc.IconLocation = '${icon.replace(/'/g, "''")}'; $sc.Description = 'YTA Empire 2'; $sc.Save();`;
            execSync(`powershell -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: 'ignore' });
            console.log('✅ Desktop shortcut created');
        }
        fs.writeFileSync(fvpRegisteredFlag, new Date().toISOString());
    } catch (e) { /* silent fail on first try */ }
}

// ========================================
// Helper Functions
// ========================================

function updateEnvFile(key, value) {
    const envPath = path.join(PROJECT_DIR, '.env');

    try {
        let envContent = '';
        if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(envPath, 'utf8');
        }

        const regex = new RegExp(`^${key}=.*$`, 'm');

        if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${key}=${value}`);
        } else {
            envContent += `\n${key}=${value}`;
        }

        fs.writeFileSync(envPath, envContent.trim() + '\n');
        console.log(`✅ Updated ${key} in .env`);
    } catch (error) {
        console.error('Failed to update .env:', error);
    }
}

function ensureWindowsRemotionBinariesDir() {
    const sourceDir = path.join(APP_ROOT, 'node_modules', '@remotion', 'compositor-win32-x64-msvc');
    const sourceCompositorBin = path.join(sourceDir, 'compositor.bin');
    const sourceRemotionExe = path.join(sourceDir, 'remotion.exe');

    if (!fs.existsSync(sourceCompositorBin) && !fs.existsSync(sourceRemotionExe)) {
        throw new Error('Remotion compositor files are missing. Try: npm install @remotion/compositor-win32-x64-msvc --force');
    }

    // Keep binaries under app-owned temp (not inside project folders like Downloads)
    // to avoid Windows EPERM / Controlled Folder Access issues.
    // Use per-project subfolders to avoid cross-instance file contention.
    const projectKey = crypto.createHash('sha1').update(PROJECT_DIR).digest('hex').slice(0, 12);
    const binariesDir = path.join(APP_ROOT, 'temp', 'remotion-binaries', projectKey);
    if (!fs.existsSync(binariesDir)) {
        fs.mkdirSync(binariesDir, { recursive: true });
    }

    for (const dirent of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        if (!dirent.isFile()) {
            continue;
        }

        const sourceFile = path.join(sourceDir, dirent.name);
        const destFile = path.join(binariesDir, dirent.name);
        // Only copy if dest doesn't exist or has wrong size
        // Skip mtime check — if another instance has the file locked, we don't need to re-copy
        const needsCopy = !fs.existsSync(destFile) ||
            fs.statSync(sourceFile).size !== fs.statSync(destFile).size;

        if (needsCopy) {
            try {
                fs.copyFileSync(sourceFile, destFile);
            } catch (e) {
                // EPERM/EBUSY = another instance is using this file — that's fine, it exists
                if (fs.existsSync(destFile)) {
                    console.log(`⚠️ Could not overwrite ${dirent.name} (in use by another instance), using existing copy`);
                } else {
                    throw e; // File doesn't exist and we can't create it — real error
                }
            }
        }
    }

    const targetCompositorBin = path.join(binariesDir, 'compositor.bin');
    const targetRemotionExe = path.join(binariesDir, 'remotion.exe');
    if (!fs.existsSync(targetRemotionExe) && fs.existsSync(targetCompositorBin)) {
        try {
            fs.copyFileSync(targetCompositorBin, targetRemotionExe);
        } catch (e) {
            if (!fs.existsSync(targetRemotionExe)) throw e;
            console.log('⚠️ Could not copy compositor.bin → remotion.exe (in use), using existing copy');
        }
    }

    if (!fs.existsSync(targetRemotionExe)) {
        throw new Error('Remotion executable could not be prepared. Add a Windows Security exclusion for this project and retry.');
    }

    return binariesDir;
}

// ========================================
// Error Handling
// ========================================
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});
