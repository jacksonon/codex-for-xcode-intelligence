#!/usr/bin/env bash
set -euo pipefail

# Start the local OpenAI-compatible server with streaming disabled.
# Use this when your IDE expects non-stream (single JSON) responses.

CODEX_BIN_DEFAULT=$(command -v codex 2>/dev/null || true)
export CODEX_BIN="${CODEX_BIN:-${CODEX_BIN_DEFAULT}}"
if [[ -z "${CODEX_BIN}" ]]; then
  echo "ERROR: codex binary not found in PATH. Set CODEX_BIN explicitly." >&2
  exit 1
fi

export FORCE_NON_STREAM=1
export PROMPT_MODE="${PROMPT_MODE:-raw_last}"

echo "[start-nonstream] Using CODEX_BIN='${CODEX_BIN}', PROMPT_MODE='${PROMPT_MODE}', FORCE_NON_STREAM=1"
exec node "$(dirname "$0")/server.js"

