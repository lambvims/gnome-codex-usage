#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_UUID="codex-usage@local"
EXT_SRC="${ROOT_DIR}/gnome-shell/${EXT_UUID}"
EXT_DEST="${HOME}/.local/share/gnome-shell/extensions/${EXT_UUID}"
BIN_DEST="${HOME}/.local/bin"

install -d "${EXT_DEST}" "${BIN_DEST}"
install -m 0755 "${ROOT_DIR}/scripts/codex-usage-status" "${BIN_DEST}/codex-usage-status"
install -m 0644 "${EXT_SRC}/metadata.json" "${EXT_DEST}/metadata.json"
install -m 0644 "${EXT_SRC}/extension.js" "${EXT_DEST}/extension.js"
install -m 0644 "${EXT_SRC}/stylesheet.css" "${EXT_DEST}/stylesheet.css"

echo "Installed ${EXT_UUID}"
echo "Enable with: gnome-extensions enable ${EXT_UUID}"

