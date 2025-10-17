#!/usr/bin/env bash
set -euo pipefail

# Start the local OpenAI-compatible server with streaming forced ON.
# This is the recommended launcher for IDEs (e.g., Xcode Locally Hosted)
# that expect SSE streaming responses by default.

CODEX_BIN_DEFAULT=$(command -v codex 2>/dev/null || true)
export CODEX_BIN="${CODEX_BIN:-${CODEX_BIN_DEFAULT}}"
if [[ -z "${CODEX_BIN}" ]]; then
  echo "ERROR: codex binary not found in PATH. Set CODEX_BIN explicitly." >&2
  exit 1
fi

# Force SSE streaming and keep the prompt minimal (last user message only).
export FORCE_STREAM=1
export PROMPT_MODE="${PROMPT_MODE:-raw_last}"

# Optional: set CODEX_WORKDIR to point Codex at a specific repo
# export CODEX_WORKDIR="/path/to/your-repo"

echo "[start-stream] Using CODEX_BIN='${CODEX_BIN}', PROMPT_MODE='${PROMPT_MODE}', FORCE_STREAM=1"
exec node "$(dirname "$0")/server.js"

