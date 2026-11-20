#!/usr/bin/env bash
# `graph test` only downloads a Linux matchstick binary for Ubuntu 22/24
# (matchstick >= 0.5.5). Debian 13 reports "Unsupported platform: Linux x64 13"
# and docker is not used here. The official LimeChain `binary-linux-22` binary
# runs on this host; reuse it when already present, otherwise download it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BIN="$ROOT/tests/.bin/matchstick"
GRAPH="$ROOT/node_modules/.bin/graph"

linux_major() {
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    echo "${VERSION_ID%%.*}"
  else
    echo ""
  fi
}

need_linux22_fallback=0
if [[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]]; then
  ver="$(linux_major)"
  if [[ "$ver" != "22" && "$ver" != "24" ]]; then
    need_linux22_fallback=1
  fi
fi

if [[ ! -x "$BIN" && "$need_linux22_fallback" == 1 ]]; then
  mkdir -p "$ROOT/tests/.bin"
  ver="0.6.0"
  if [[ -f "$ROOT/tests/.latest.json" ]]; then
    ver="$(node -p "require('$ROOT/tests/.latest.json').version" 2>/dev/null || echo 0.6.0)"
  fi
  url="https://github.com/LimeChain/matchstick/releases/download/${ver}/binary-linux-22"
  echo "graph test is unsupported on this Linux (not Ubuntu 22/24); downloading matchstick ${ver} binary-linux-22"
  curl -fL --retry 3 -o "$BIN" "$url"
  chmod +x "$BIN"
fi

if [[ -x "$BIN" ]]; then
  exec "$BIN" "$@"
fi

exec "$GRAPH" test "$@"
