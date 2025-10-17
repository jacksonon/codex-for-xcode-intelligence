# Repository Guidelines

## Project Structure & Module Organization
- `server.js` hosts the OpenAI-compatible gateway that translates chat requests into `codex exec` invocations and exports health/debug endpoints.
- `forwarder.js` exposes a lean `/ask` interface for agents that only need plain-text completions; reuse shared helpers rather than duplicating logic.
- `ask-codex.js` is a CLI wrapper useful for smoke checks and quick prompts straight from the terminal.
- `start-stream.sh` and `start-nonstream.sh` bootstrap the server with sensible defaults; prefer these scripts over calling `node server.js` when integrating with tools.

## Build, Run, and Development Commands
- `./start-stream.sh` launches the server with forced SSE streaming; ideal for IDEs expecting incremental tokens.
- `./start-nonstream.sh` starts the same server but returns single JSON payloads for tools that do not handle SSE.
- `PORT=3050 node forwarder.js` spins up the minimal `/ask` forwarder; adjust `PORT` or `CODEX_BIN`/`CODEX_WORKDIR` as needed.
- `node server.js` runs the OpenAI-compatible API directly if you need custom environment combinations.

## Coding Style & Naming
- Stick to modern Node.js (18+) syntax, `const`/`let`, and the existing 2-space indentation with trailing semicolons.
- Keep modules dependency-free and prefer small, pure helpers—these binaries are designed to start instantly.
- Name new scripts with hyphenated lowercase filenames (`new-tool.sh`, `batch-forwarder.js`) to match the current pattern.

## Testing & Quality Checks
- There is no automated test harness; rely on scripted smoke runs: `curl http://127.0.0.1:3040/health` and `node ask-codex.js "ping"` should both succeed.
- Before shipping changes affecting streaming, verify with `./start-stream.sh` plus a sample chat request to confirm SSE headers and payload order.
- Capture stderr output when validating failure paths—diagnostics surface there even in JSON mode.

## Commit & Pull Request Guidelines
- Follow Conventional Commits (`feat:`, `fix:`, `chore:`); keep subject lines under ~70 characters and describe scope precisely.
- Reference related issues in the PR body, outline reproduction steps, and note any environment variables that must be set.
- Include before/after behavior notes or sample responses when tweaking request formatting or Codex invocation flags.
- Ensure scripts remain executable (`chmod +x`) and document new flags in `README.md` before requesting review.
