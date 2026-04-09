#!/usr/bin/env node
//
// KameClaude CLI — launches the Electron app and (on first run) auto-installs
// a Claude Code Stop hook into ~/.claude/settings.json.
//
// Usage:
//   kameclaude                 # launch app (installs hook on first run)
//   kameclaude install         # install hook only
//   kameclaude uninstall       # remove hook only
//   kameclaude --no-install    # launch without touching settings.json
//
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BLAST_URL = 'http://127.0.0.1:47832/blast';
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const TOKEN_DIR = path.join(os.homedir(), '.kameclaude');
const TOKEN_FILE = path.join(TOKEN_DIR, 'token');
// Marker substring used to identify *our* Stop hooks (both legacy and current)
// so upgrades can replace rather than duplicate.
const HOOK_MARKER = '127.0.0.1:47832/blast';

function log(msg) { process.stdout.write(`kameclaude: ${msg}\n`); }
function isPlainObject(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }

function loadOrCreateToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (/^[a-f0-9]{48}$/.test(t)) return t;
    }
  } catch (_) { /* regenerate */ }
  const fresh = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, fresh, { mode: 0o600 });
  return fresh;
}

function buildHookCommand(token) {
  // Token is 48-char hex — shell-safe by construction (no metacharacters).
  // -X POST + header match the server's auth check.
  return `curl -s --max-time 1 -X POST -H "X-KameClaude-Token: ${token}" ${BLAST_URL} >/dev/null 2>&1 || true`;
}

function readSettingsOrNull() {
  if (!fs.existsSync(SETTINGS)) return { settings: {}, raw: null };
  const raw = fs.readFileSync(SETTINGS, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    log(`~/.claude/settings.json isn't valid JSON — refusing to touch it.`);
    log(e.message);
    return null;
  }
  if (!isPlainObject(parsed)) {
    log(`~/.claude/settings.json root must be an object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}. Refusing to touch it.`);
    return null;
  }
  return { settings: parsed, raw };
}

// Normalise settings.hooks into a plain-object shape we can safely mutate.
// Returns null (and logs) if the existing shape is unexpected, so we never
// clobber a config we don't understand.
function ensureHooksShape(settings) {
  if (settings.hooks === undefined) { settings.hooks = {}; return settings.hooks; }
  if (!isPlainObject(settings.hooks)) {
    log(`settings.hooks must be an object, got ${Array.isArray(settings.hooks) ? 'array' : typeof settings.hooks}. Refusing to touch it.`);
    return null;
  }
  if (settings.hooks.Stop === undefined) { settings.hooks.Stop = []; return settings.hooks; }
  if (!Array.isArray(settings.hooks.Stop)) {
    log(`settings.hooks.Stop must be an array, got ${typeof settings.hooks.Stop}. Refusing to touch it.`);
    return null;
  }
  return settings.hooks;
}

// Strip every Stop-hook entry that references our blast URL. Returns the
// number of entries removed. Idempotent — used by both install (to clean
// stale/legacy hooks before re-adding) and uninstall.
function stripExistingHooks(settings) {
  const stops = settings?.hooks?.Stop;
  if (!Array.isArray(stops)) return 0;
  let removed = 0;
  settings.hooks.Stop = stops
    .map(group => {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) return group;
      const kept = group.hooks.filter(h => {
        const match = isPlainObject(h) && typeof h.command === 'string' && h.command.includes(HOOK_MARKER);
        if (match) removed++;
        return !match;
      });
      return { ...group, hooks: kept };
    })
    .filter(group => !isPlainObject(group) || (Array.isArray(group.hooks) && group.hooks.length > 0));
  if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
  if (isPlainObject(settings.hooks) && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

function writeBackup(raw) {
  if (raw == null) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(`${SETTINGS}.kameclaude-${stamp}.bak`, raw);
}

function installHook() {
  try {
    const loaded = readSettingsOrNull();
    if (loaded === null) return false;
    const { settings, raw } = loaded;

    if (raw !== null) writeBackup(raw);
    else fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });

    const hooks = ensureHooksShape(settings);
    if (hooks === null) return false;

    // Upgrade path: remove any previous KameClaude hook (which may use an
    // older token or no token at all), then write the fresh one.
    const removed = stripExistingHooks(settings);
    if (removed > 0) log(`Replacing ${removed} existing KameClaude hook${removed === 1 ? '' : 's'}.`);

    const token = loadOrCreateToken();
    const cmd = buildHookCommand(token);
    settings.hooks = settings.hooks || {};
    settings.hooks.Stop = Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [];
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command: cmd }] });

    fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
    log('Installed Claude Code Stop hook. Goku will fire every time Claude finishes.');
    return true;
  } catch (err) {
    log(`Install failed: ${err?.message || err}`);
    return false;
  }
}

function uninstallHook() {
  try {
    const loaded = readSettingsOrNull();
    if (loaded === null) return false;
    const { settings, raw } = loaded;
    if (raw === null) { log('No settings.json — nothing to remove.'); return true; }

    writeBackup(raw);
    const removed = stripExistingHooks(settings);
    if (removed === 0) { log('No KameClaude hook found.'); return true; }

    fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
    log(`Removed ${removed} KameClaude hook${removed === 1 ? '' : 's'}.`);
    return true;
  } catch (err) {
    log(`Uninstall failed: ${err?.message || err}`);
    return false;
  }
}

function launchApp() {
  let electronBinary;
  try {
    electronBinary = require('electron');
  } catch (e) {
    log('Could not load Electron. Try: npm install -g kameclaude');
    process.exit(1);
  }
  const appPath = path.resolve(__dirname, '..');
  const child = spawn(electronBinary, [appPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', err => { log(`Failed to launch: ${err.message}`); process.exit(1); });
  child.unref();
  log('KameClaude is running in your menu bar. Goku awaits.');
}

// ── Dispatch ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === 'install') {
  process.exit(installHook() ? 0 : 1);
} else if (cmd === 'uninstall' || cmd === 'remove') {
  process.exit(uninstallHook() ? 0 : 1);
} else if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  process.stdout.write(`KameClaude — Goku tells you when Claude Code is done.

Usage:
  kameclaude                 Launch the menu-bar app (auto-installs hook on first run)
  kameclaude install         Install the Claude Code Stop hook only
  kameclaude uninstall       Remove the Claude Code Stop hook
  kameclaude --no-install    Launch without touching settings.json
  kameclaude --help          Show this help
`);
  process.exit(0);
} else {
  if (!args.includes('--no-install')) installHook();
  launchApp();
}
