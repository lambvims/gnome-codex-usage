# Codex Usage GNOME Shell Extension

Show local Codex usage in the GNOME Shell top bar.

The extension reads the latest `rate_limits` event from local Codex session logs
under `~/.codex/sessions`, then shows remaining 5-hour and weekly quota in the
panel.

## Local Install

```bash
./install.sh
gnome-extensions enable codex-usage@local
```

If GNOME does not load the extension immediately, log out and back in, or press
`Alt+F2`, enter `r`, and press Enter on an X11 session. On Wayland, logging out
and back in is the reliable reload path.

On Wayland, a newly installed extension may not appear in `gnome-extensions
list` until the next login because the running Shell process has not rescanned
the extensions directory yet.

## Manual Package

For sharing with another GNOME machine, zip the extension directory contents:

```bash
cd gnome-shell/codex-usage@local
zip -r ../../codex-usage@local.shell-extension.zip .
```

## Status Script

```bash
./scripts/codex-usage-status --json
./scripts/codex-usage-status
```

The script caches the last good result in:

```text
~/.cache/codex-usage/status.json
```

## Repository Layout

```text
gnome-shell/codex-usage@local/  GNOME Shell extension
scripts/codex-usage-status      Local Codex usage parser
install.sh                      Local installer
```
