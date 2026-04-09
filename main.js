const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const http = require('http');

// ── Auth token for the local /blast endpoint ───────────────────────────────
// A 48-char hex token shared between this app and the Claude Code Stop hook
// command. Stored at ~/.kameclaude/token with 0600 perms. Any process on the
// host that can read this file can trigger the overlay — equivalent in
// practice to any other local user-file, not network-reachable.
const TOKEN_DIR = path.join(os.homedir(), '.kameclaude');
const TOKEN_FILE = path.join(TOKEN_DIR, 'token');

function loadOrCreateToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (/^[a-f0-9]{48}$/.test(t)) return t;
    }
  } catch (_) { /* fall through to regenerate */ }
  const fresh = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(TOKEN_FILE, fresh, { mode: 0o600 });
  } catch (err) {
    console.warn('could not persist token:', err?.message || err);
  }
  return fresh;
}
const BLAST_TOKEN = loadOrCreateToken();

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ── Win32 FFI (Windows only) ────────────────────────────────────────────────
let keybd_event, VkKeyScanA;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    keybd_event = user32.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)');
    VkKeyScanA = user32.func('int16_t __stdcall VkKeyScanA(int ch)');
  } catch (e) {
    console.warn('koffi not available – macro sending disabled', e.message);
  }
}

// ── Globals ─────────────────────────────────────────────────────────────────
let tray, overlay;
let overlayReady = false;
let spawnQueued = false;

const VK_CONTROL = 0x11;
const VK_RETURN  = 0x0D;
const VK_C       = 0x43;
const VK_MENU    = 0x12; // Alt
const VK_TAB     = 0x09;
const KEYUP      = 0x0002;

/** One Alt+Tab / Cmd+Tab so focus returns to the previously active app after tray click. */
function refocusPreviousApp() {
  const delayMs = 80;
  const run = () => {
    if (process.platform === 'win32') {
      if (!keybd_event) return;
      keybd_event(VK_MENU, 0, 0, 0);
      keybd_event(VK_TAB, 0, 0, 0);
      keybd_event(VK_TAB, 0, KEYUP, 0);
      keybd_event(VK_MENU, 0, KEYUP, 0);
    } else if (process.platform === 'darwin') {
      const script = [
        'tell application "System Events"',
        '  key down command',
        '  key code 48', // Tab
        '  key up command',
        'end tell',
      ].join('\n');
      execFile('osascript', ['-e', script], err => {
        if (err) {
          console.warn('refocus previous app (Cmd+Tab) failed:', err.message);
        }
      });
    }
  };
  setTimeout(run, delayMs);
}

// Load icon/dbz-source.png (grid-paper pixel-art Z with a watermark),
// crop to the colored logo, and alpha-key the white/grid background away.
// Used as the tray icon when present.
function buildDbzTrayIcon() {
  const src = path.join(__dirname, 'icon', 'dbz-source.png');
  if (!fs.existsSync(src)) return null;
  const img = nativeImage.createFromPath(src);
  if (img.isEmpty()) return null;
  const { width: W, height: H } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  // Detect "colored" pixels: saturated (not near-white, not grid-gray).
  const isLogo = (r, g, b) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx > 235 && mn > 210) return false; // near-white / paper
    if (mx - mn < 30 && mx > 170) return false; // grid-gray
    // Pale watermark: low saturation and high luminance.
    const lum = 0.299*r + 0.587*g + 0.114*b;
    if (lum > 210 && (mx - mn) < 70) return false;
    return true;
  };

  // Bounding box of the logo.
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const b = bmp[i], g = bmp[i+1], r = bmp[i+2];
      if (isLogo(r, g, b)) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;

  // Add a 1-cell pad, then build a clean RGBA buffer cropped to the bbox.
  const pad = 4;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(W - 1, maxX + pad);
  maxY = Math.min(H - 1, maxY + pad);
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const si = ((y + minY) * W + (x + minX)) * 4;
      const di = (y * cw + x) * 4;
      const bb = bmp[si], gg = bmp[si+1], rr = bmp[si+2];
      if (isLogo(rr, gg, bb)) {
        out[di]     = bb; // B
        out[di + 1] = gg; // G
        out[di + 2] = rr; // R
        out[di + 3] = 255;
      } else {
        out[di]     = 0;
        out[di + 1] = 0;
        out[di + 2] = 0;
        out[di + 3] = 0;
      }
    }
  }
  const cropped = nativeImage.createFromBitmap(out, { width: cw, height: ch });
  // Menu bar target size: ~22pt high. Keep a 2x variant.
  // Menu bar visual height. macOS caps display height around 22pt, but
  // rendering at 30 and letting AppKit scale keeps the logo sharp and bold.
  const targetH = 30;
  const targetW = Math.round(cw * (targetH / ch));
  const at1 = cropped.resize({ width: targetW, height: targetH, quality: 'best' });
  const at2 = cropped.resize({ width: targetW * 2, height: targetH * 2, quality: 'best' });
  at1.addRepresentation({ scaleFactor: 2, buffer: at2.toPNG() });
  return at1;
}

function createTrayIconFallback() {
  const p = path.join(__dirname, 'icon', 'Template.png');
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) {
      if (process.platform === 'darwin') img.setTemplateImage(true);
      return img;
    }
  }
  console.warn('kameclaude: icon/Template.png missing or invalid');
  return nativeImage.createEmpty();
}

async function tryIcnsTrayImage(icnsPath) {
  const size = { width: 64, height: 64 };
  const thumb = await nativeImage.createThumbnailFromPath(icnsPath, size);
  if (!thumb.isEmpty()) return thumb;
  return null;
}

// macOS: createFromPath does not decode .icns (Electron only loads PNG/JPEG there, ICO on Windows).
// Quick Look thumbnails handle .icns; copy to temp if the file is inside ASAR (QL needs a real path).
async function getTrayIcon() {
  const iconDir = path.join(__dirname, 'icon');
  if (process.platform === 'win32') {
    const file = path.join(iconDir, 'icon.ico');
    if (fs.existsSync(file)) {
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) return img;
    }
    return createTrayIconFallback();
  }
  if (process.platform === 'darwin') {
    // Prefer the colorful DBZ logo extracted from the user's reference image.
    const dbz = buildDbzTrayIcon();
    if (dbz) return dbz; // NOT a template — it's color.
    const file = path.join(iconDir, 'AppIcon.icns');
    if (fs.existsSync(file)) {
      const fromPath = nativeImage.createFromPath(file);
      if (!fromPath.isEmpty()) return fromPath;
      try {
        const t = await tryIcnsTrayImage(file);
        if (t) return t;
      } catch (e) {
        console.warn('AppIcon.icns Quick Look thumbnail failed:', e?.message || e);
      }
      const tmp = path.join(os.tmpdir(), 'kameclaude-tray.icns');
      try {
        fs.copyFileSync(file, tmp);
        const t = await tryIcnsTrayImage(tmp);
        if (t) return t;
      } catch (e) {
        console.warn('AppIcon.icns temp copy + thumbnail failed:', e?.message || e);
      }
    }
    return createTrayIconFallback();
  }
  return createTrayIconFallback();
}

// ── Overlay window ──────────────────────────────────────────────────────────
function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    x: bounds.x, y: bounds.y,
    width: bounds.width, height: bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Explicit hardening — these are the modern Electron defaults but we
      // pin them here so a future upgrade can't silently flip them.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  // 'floating' sits above normal windows but below the menu bar / mission
  // control; 'screen-saver' can hijack input on macOS even with click-through.
  overlay.setAlwaysOnTop(true, 'floating');
  // Start click-through; overlay.html flips this off when the scene is active.
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlayReady = false;
  overlay.webContents.on('dom-ready', () => {
    overlayReady = true;
    if (spawnQueued && overlay && overlay.isVisible()) {
      const msg = spawnQueued === 'auto-blast' ? 'auto-blast' : 'spawn-whip';
      spawnQueued = false;
      overlay.webContents.send(msg);
      refocusPreviousApp();
    }
  });
  overlay.webContents.on('console-message', (_e, level, message) => {
    console.log(`[overlay] ${message}`);
  });
  overlay.loadFile(path.join(__dirname, 'overlay.html'));
  overlay.on('closed', () => {
    overlay = null;
    overlayReady = false;
    spawnQueued = false;
  });
}

// Triggered by an external signal (e.g. Claude Code Stop hook).
// Spawns Goku, has him auto-fire a short kamehameha, then closes.
function runAutoBlast() {
  if (overlay && overlay.isVisible()) {
    overlay.webContents.send('auto-blast');
    return;
  }
  if (!overlay) createOverlay();
  overlay.show();
  if (overlayReady) {
    overlay.webContents.send('auto-blast');
    refocusPreviousApp();
  } else {
    spawnQueued = 'auto-blast';
  }
}

function toggleOverlay() {
  if (overlay && overlay.isVisible()) {
    overlay.webContents.send('drop-whip');
    return;
  }
  if (!overlay) createOverlay();
  overlay.show();
  if (overlayReady) {
    overlay.webContents.send('spawn-whip');
    refocusPreviousApp();
  } else {
    spawnQueued = true;
  }
}

// ── IPC ─────────────────────────────────────────────────────────────────────
ipcMain.on('goku-blast', (_e, text) => {
  try {
    const phrase = typeof text === 'string' && text.length ? text : 'POWER UP';
    if (process.platform === 'win32') sendMacroWindows(phrase);
    else if (process.platform === 'darwin') sendMacroMac(phrase);
  } catch (err) {
    console.warn('goku-blast failed:', err?.message || err);
  }
});
// Show a native macOS notification banner with a Goku quote.
// Read-only — can never become input to any focused app.
ipcMain.on('show-notification', (_e, text) => {
  if (process.platform !== 'darwin') return;
  const phrase = (typeof text === 'string' ? text : '').replace(/[\\"]/g, '\\$&');
  if (!phrase) return;
  const script = `display notification "${phrase}" with title "Goku" sound name "Hero"`;
  execFile('osascript', ['-e', script], err => {
    if (err) console.warn('notification failed:', err.message);
  });
});

ipcMain.on('hide-overlay', () => {
  if (!overlay) return;
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.hide();
});
ipcMain.on('set-click-through', (_e, clickThrough) => {
  if (!overlay) return;
  if (clickThrough) overlay.setIgnoreMouseEvents(true, { forward: true });
  else overlay.setIgnoreMouseEvents(false);
});

function sendMacroWindows(text) {
  if (!keybd_event || !VkKeyScanA) return;
  const tapKey = vk => {
    keybd_event(vk, 0, 0, 0);
    keybd_event(vk, 0, KEYUP, 0);
  };
  const tapChar = ch => {
    const packed = VkKeyScanA(ch.charCodeAt(0));
    if (packed === -1) return;
    const vk = packed & 0xff;
    const shiftState = (packed >> 8) & 0xff;
    if (shiftState & 1) keybd_event(0x10, 0, 0, 0); // Shift down
    tapKey(vk);
    if (shiftState & 1) keybd_event(0x10, 0, KEYUP, 0); // Shift up
  };

  // Ctrl+C (interrupt)
  keybd_event(VK_CONTROL, 0, 0, 0);
  keybd_event(VK_C, 0, 0, 0);
  keybd_event(VK_C, 0, KEYUP, 0);
  keybd_event(VK_CONTROL, 0, KEYUP, 0);
  for (const ch of text) tapChar(ch);
  keybd_event(VK_RETURN, 0, 0, 0);
  keybd_event(VK_RETURN, 0, KEYUP, 0);
}

function sendMacroMac(text) {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = [
    'tell application "System Events"',
    '  key code 8 using {command down}', // Cmd+C
    '  delay 0.03',
    `  keystroke "${escaped}"`,
    '  key code 36', // Enter
    'end tell'
  ].join('\n');

  execFile('osascript', ['-e', script], err => {
    if (err) {
      console.warn('mac macro failed (enable Accessibility for terminal/app):', err.message);
    }
  });
}

// ── App lifecycle ───────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  tray = new Tray(await getTrayIcon());
  tray.setToolTip('KameClaude – Goku tells you when Claude Code is done');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Summon Goku', click: toggleOverlay },
      { label: 'Fire kamehameha now', click: runAutoBlast },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
  tray.on('click', toggleOverlay);

  // Panic escape: always hide the overlay. The overlay window is
  // focusable:false, so in-page keydown Escape never fires — register
  // a global shortcut so the user is never trapped.
  globalShortcut.register('Escape', () => {
    if (overlay && overlay.isVisible()) overlay.hide();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());

// Local HTTP trigger so external tools (e.g. Claude Code's Stop hook) can
// fire Goku when processing finishes. Loopback-only (127.0.0.1) and requires
// a matching X-KameClaude-Token header so arbitrary local processes can't
// spam the overlay. The token is the same shared secret the CLI embeds into
// the Claude Code Stop hook command.
//
// This endpoint takes no parameters, returns no data, and only renders a
// local UI animation — by design, not SSRF- or open-redirect-shaped.
const TRIGGER_PORT = 47832;
const triggerServer = http.createServer((req, res) => {
  // Strip any query string; route on pathname only. No parameter parsing.
  const pathname = (req.url || '').split('?')[0];
  if (pathname !== '/blast') {
    res.writeHead(404); res.end('not found\n'); return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Allow': 'POST' }); res.end(); return;
  }
  const provided = req.headers['x-kameclaude-token'];
  if (!timingSafeEqualStr(Array.isArray(provided) ? provided[0] : provided, BLAST_TOKEN)) {
    res.writeHead(401); res.end(); return;
  }
  runAutoBlast();
  res.writeHead(204); res.end();
});
triggerServer.on('error', err => {
  console.warn('kameclaude trigger server failed to bind:', err.message);
});
triggerServer.listen(TRIGGER_PORT, '127.0.0.1', () => {
  console.log(`kameclaude trigger listening on http://127.0.0.1:${TRIGGER_PORT}/blast`);
});

app.on('window-all-closed', e => e.preventDefault()); // keep alive in tray
