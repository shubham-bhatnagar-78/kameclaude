# KameClaude

> **Goku tells you when Claude Code is done.**

A tiny menu-bar app that turns every Claude Code completion into a 4-second anime power-up. Impossible to miss. Annoying to your coworkers. Joyful to you.

![KameClaude demo](assets/divider.png)

## Install

```bash
npm install -g kameclaude
kameclaude
```

That's it. On first run, KameClaude:
1. Installs a **Stop hook** into `~/.claude/settings.json` (a timestamped backup is saved next to it).
2. Launches the menu-bar app.
3. Every time Claude Code finishes, Goku materializes on your screen, charges a kamehameha, fires, and instant-transmissions away.

## Commands

```bash
kameclaude                 # launch app (installs hook on first run)
kameclaude install         # install the Claude Code Stop hook only
kameclaude uninstall       # remove the Claude Code Stop hook
kameclaude --no-install    # launch without touching settings.json
kameclaude --help          # show help
```

## How it works

KameClaude runs a tiny HTTP trigger at `http://127.0.0.1:47832/blast`. The install step adds a `Stop` hook to `~/.claude/settings.json` that `curl`s this endpoint when Claude Code finishes:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s --max-time 1 http://127.0.0.1:47832/blast >/dev/null 2>&1 || true"
          }
        ]
      }
    ]
  }
}
```

Anything that can `curl` can trigger Goku — use it from other tools, scripts, shell aliases, whatever.

## Tray menu

- **Summon Goku** — interactive mode. Follows your cursor; hold to charge, release to fire, double-click for instant transmission.
- **Fire kamehameha now** — manual trigger.
- **Quit**.

## Interactive controls

- **Hold mouse**: charge a long kamehameha. Release to fire.
- **Click**: fire a short beam.
- **Double-click Goku**: instant transmission away.
- **Escape**: panic hide.

## Platform support

- **macOS**: first-class. First launch may prompt for Accessibility permission.
- **Windows**: works via Electron. Native refocus needs the optional `koffi` dep (auto-installed when available).
- **Linux**: works on X11. Wayland + GNOME tray support is flaky (known Electron issue).

## Develop

```bash
git clone https://github.com/GitFrog1111/badclaude
cd badclaude
npm install
npm start
```

## Disclaimer

KameClaude is an unofficial fan project. Goku, Dragon Ball, and all related marks are property of Bird Studio / Shueisha / Toei Animation. Free, open source, no affiliation with Anthropic or Toei.

## License

MIT.
