#!/usr/bin/env bash
# Server Start Guard installer for mac/linux (POSIX).
# Mirrors what install.bat's embedded PowerShell does on Windows:
#   1. copy dist/* -> ~/.config/opencode/plugins/server-start-guard/dist/
#   2. seed a default config.json if absent (never clobbers an existing one)
#   3. register the plugin in the global opencode.jsonc / opencode.json
# Requires the whole release folder (dist/ + this script) on disk.
set -euo pipefail

src="${SSG_PKG:-$(cd "$(dirname "$0")" && pwd)}"
if [ -z "$src" ]; then
  echo "Package folder not found. Re-run with whole release folder." >&2
  exit 1
fi

root="$HOME/.config/opencode"
pd="$root/plugins/server-start-guard"
dd="$pd/dist"
mkdir -p "$dd"

if [ -f "$src/dist/index.js" ]; then
  cp -R "$src/dist/." "$dd/"
else
  echo "dist/index.js was not found next to install.sh. Re-download the whole release folder." >&2
  exit 1
fi

cfg="$pd/config.json"
if [ ! -f "$cfg" ]; then
  printf '%s' '{"enabled": true, "extraPatterns": []}' > "$cfg"
fi

entry="file://$pd/dist/index.js"
if [ -f "$root/opencode.jsonc" ]; then
  ocCfg="$root/opencode.jsonc"
elif [ -f "$root/opencode.json" ]; then
  ocCfg="$root/opencode.json"
else
  ocCfg="$root/opencode.jsonc"
fi

# No config at all -> create a minimal one.
if [ ! -f "$ocCfg" ]; then
  cat > "$ocCfg" <<EOF
{ "$schema": "https://opencode.ai/config.json", "plugin": ["$entry"] }
EOF
  echo "Server Start Guard installed."
  exit 0
fi

if grep -qF "$entry" "$ocCfg"; then
  echo "Server Start Guard installed (already registered)."
  exit 0
fi

# Ordered as in install.bat: append to an existing "plugin" array, else inject
# a fresh "plugin" key after the opening brace. Plain text transformations on
# JSONC; if you hand-edited the file into an unusual shape, register manually
# by adding the entry to the "plugin" array.
if grep -Eq '"plugin"[[:space:]]*:[[:space:]]*\[' "$ocCfg"; then
  sed -E -i "s/(\"plugin\"[[:space:]]*:[[:space:]]*\[)/\1\n    \"$entry\",/" "$ocCfg"
else
  sed -E -i "s/^([[:space:]]*\{)/\1\n  \"plugin\": [\n    \"$entry\"\n  ],/" "$ocCfg"
fi

echo "Server Start Guard installed."
echo "Restart opencode to load the plugin."