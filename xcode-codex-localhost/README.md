Xcode Locally Hosted with Codex

A tiny OpenAI-compatible local server that proxies requests to the Codex CLI (`codex exec`). Point Xcode’s “Locally Hosted” provider at this server to use your local Codex for assistance.

Requirements
- Node.js 18+
- Codex CLI installed and on PATH (`codex --version`)

Quick Start
- Run (streaming for IDEs): `./start-stream.sh`
- Or non-streaming: `./start-nonstream.sh`
- Base URL: `http://127.0.0.1:3040`
- Models endpoint: `GET /v1/models` → lists `codex-exec`
- Chat Completions: `POST /v1/chat/completions`

Why this works
- We translate OpenAI Chat Completions inputs into a single Codex task and run `codex exec --json --skip-git-repo-check`.
- We collect the final `agent_message` and return it as the assistant message.
- When `stream: true`, we stream a single chunk followed by `[DONE]` (Codex currently emits the final assistant message at the end of the turn in JSONL mode).

Default safety flags
- The server always invokes Codex with `--skip-git-repo-check` so it can run outside a Git repository. If you prefer to enforce the Git check, remove this flag in `server.js`.

Endpoints
- `GET /health` → `{ ok: true }`
- `GET /debug/check` → environment + settings snapshot
- `GET /v1/models` → `{ data: [{ id: "codex-exec" }] }`
- `POST /v1/chat/completions`
  - Body (subset of OpenAI schema):
    - `model` (string, required) — use `codex-exec`
    - `messages` (array of `{ role, content }`) — standard chat history
    - `stream` (boolean) — default false
    - Optional passthrough: `temperature`, `top_p`, `max_tokens`, `stop` (ignored)
  - Response (non-stream): OpenAI-compatible `chat.completion`
  - Response (stream): SSE with `chat.completion.chunk` frames; final frame has `finish_reason: "stop"`, then `[DONE]`.

Environment variables
- `PORT` (default `3040`)
- `CODEX_BIN` (default `codex`)
- `CODEX_WORKDIR` (optional; working directory for `codex exec`)
- `PROMPT_MODE` (default `raw_last`; `transcript` also supported)
- `REQUIRE_API_KEY` (set to any value to enable token check)
- `API_KEY` (when `REQUIRE_API_KEY` is set, incoming `Authorization: Bearer` must equal this)
- `FORCE_NON_STREAM` or `DISABLE_STREAM` (any value to ignore `stream:true` and always return non-stream responses)
- `FORCE_STREAM` (any value to force streaming SSE responses regardless of request payload)

Xcode configuration (Locally Hosted)
- Open Xcode Settings → (AI/Intelligence) Locally Hosted
- Base URL: `http://127.0.0.1:3040`
- API Key: leave empty (or any placeholder if UI requires)
- Model: `codex-exec`

Notes
- This server runs Codex in non-interactive mode and does not request file edit/network permissions. It uses `--skip-git-repo-check` to avoid requiring a Git repo.
- If you want Codex to operate inside a repo, set `CODEX_WORKDIR` to that path and remove `--skip-git-repo-check` in `server.js`.
