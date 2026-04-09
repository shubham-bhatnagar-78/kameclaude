# KameClaude

> **Goku tells you when Claude Code is done.**

A tiny menu-bar app that turns every Claude Code completion into a 4-second anime power-up. Impossible to miss. Annoying to your coworkers. Joyful to you.

<img src="assets/goku_sheet.png" alt="Goku sprite sheet" width="320" />

## Install

```bash
git clone https://github.com/shubham-bhatnagar-78/kameclaude
cd kameclaude
npm install
npm start
```

That's it. On first `npm start`, KameClaude:
1. Generates an auth token at `~/.kameclaude/token` (so only you can trigger Goku).
2. Installs a token-authed **Stop hook** into `~/.claude/settings.json` (a timestamped backup is saved next to it).
3. Launches the menu-bar app.

Every time Claude Code finishes, Goku materializes on your screen, charges a kamehameha, fires, and instant-transmissions away.

## Commands

```bash
npm start                      # launch app (installs hook on first run)
npm run install-hook           # install the Claude Code Stop hook only
npm run uninstall-hook         # remove the Claude Code Stop hook
node bin/kameclaude.js --help  # show all CLI options
```

## How it works

KameClaude runs a tiny local HTTP trigger at `http://127.0.0.1:47832/blast`. The install step:

1. Generates a 48-char hex token at `~/.kameclaude/token` (mode `0600`) if one doesn't already exist.
2. Adds a `Stop` hook to `~/.claude/settings.json` that `POST`s to the endpoint with a matching `X-KameClaude-Token` header when Claude Code finishes:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s --max-time 1 -X POST -H \"X-KameClaude-Token: <your-token>\" http://127.0.0.1:47832/blast >/dev/null 2>&1 || true"
          }
        ]
      }
    ]
  }
}
```

The endpoint is loopback-only, requires `POST`, and rejects anything without a matching token — so random processes on your machine can't spam the overlay. Any tool that can read `~/.kameclaude/token` can fire Goku by `curl`ing with the header above.

## Tray

Left-click the menu bar icon to summon Goku. Right-click for **Quit**. No other menu.

## Interactive controls

- **Hold mouse**: charge a long kamehameha. Release to fire.
- **Click**: fire a short beam.
- **Double-click Goku**: instant transmission away.
- **Escape**: panic hide.

## Platform support

- **macOS**: first-class. First launch may prompt for Accessibility permission.
- **Windows**: works via Electron. Native refocus needs the optional `koffi` dep (auto-installed when available).
- **Linux**: works on X11. Wayland + GNOME tray support is flaky (known Electron issue).

## Disclaimer

KameClaude is an unofficial fan project. Goku, Dragon Ball, and all related marks are property of Bird Studio / Shueisha / Toei Animation. Free, open source, no affiliation with Anthropic or Toei.

## License

MIT.
