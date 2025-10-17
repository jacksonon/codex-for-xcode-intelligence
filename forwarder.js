#!/usr/bin/env node
// Minimal forwarder: POST /ask with body (JSON {q|prompt|message} or raw text)
// → runs `codex exec --json` and returns the final agent message as text/plain.

const http = require('http');
const { spawn } = require('child_process');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3050;
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CODEX_WORKDIR = process.env.CODEX_WORKDIR || process.cwd();
const EXEC_TIMEOUT_MS = process.env.EXEC_TIMEOUT_MS ? Number(process.env.EXEC_TIMEOUT_MS) : 120000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function runCodexExec(taskPrompt) {
  const args = ['exec', '--json', '--skip-git-repo-check', taskPrompt];
  const child = spawn(CODEX_BIN, args, {
    cwd: CODEX_WORKDIR,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let finalAssistant = '';
  let usage = undefined;
  let errorObj = null;
  let buffer = '';
  let spawnError = null;
  let aggregatedStderr = '';

  child.on('error', (err) => {
    spawnError = err;
  });

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        if (evt?.type === 'item.completed' && evt.item?.type === 'agent_message') {
          if (typeof evt.item.text === 'string') finalAssistant = evt.item.text;
        } else if (evt?.type === 'turn.completed' && evt.usage) {
          usage = evt.usage;
        } else if (evt?.type === 'turn.failed') {
          errorObj = evt.error || { message: 'Codex turn failed' };
        }
      } catch {
        // ignore non-JSON lines
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    // Non-fatal progress and logs are expected on stderr in default mode; in --json mode
    // we still may get diagnostic messages. We do not treat stderr as fatal here.
    aggregatedStderr += chunk.toString('utf8');
  });

  let settled = false;
  const exited = new Promise((resolve) => {
    child.on('close', (code) => { settled = true; resolve({ code }); });
    child.on('error', (err) => { if (!settled) { settled = true; resolve({ code: -1, error: err }); } });
  });

  const killTimer = setTimeout(() => {
    if (!settled) {
      errorObj = { message: `Timed out after ${EXEC_TIMEOUT_MS}ms` };
      try { child.kill('SIGKILL'); } catch {}
    }
  }, EXEC_TIMEOUT_MS);

  return { exited: exited.finally(() => clearTimeout(killTimer)), getFinal() { return { finalAssistant, usage, errorObj, spawnError, aggregatedStderr }; } };
}

function text(res, status, body, headers = {}) {
  const buf = Buffer.from(body || '');
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(buf.length), ...headers });
  res.end(buf);
}

function json(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(buf.length) });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/ask') {
      const raw = await readBody(req);
      let question = '';
      try {
        const obj = JSON.parse(raw);
        question = obj.q || obj.prompt || obj.message || '';
      } catch {
        question = raw.trim();
      }
      if (!question) return text(res, 400, 'missing question');

      const { exited, getFinal } = runCodexExec(question);
      const { code } = await exited;
      const { finalAssistant, usage, errorObj, spawnError, aggregatedStderr } = getFinal();
      if (spawnError) return text(res, 500, `Failed to start codex: ${spawnError.message}. Set CODEX_BIN or update PATH.`);
      if (errorObj) return text(res, 500, errorObj.message || 'codex failed');
      if (code !== 0) {
        const msg = (aggregatedStderr || '').trim() || `Codex exited with code ${code}`;
        return text(res, 500, msg);
      }
      const headers = {};
      if (usage) headers['x-codex-usage'] = JSON.stringify(usage);
      headers['x-codex-exit-code'] = String(code);
      return text(res, 200, finalAssistant || '', headers);
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    text(res, 500, e?.message || 'internal error');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[codex-forwarder] listening on http://127.0.0.1:${PORT}`);
  console.log(`[codex-forwarder] Using CODEX_BIN='${CODEX_BIN}', CODEX_WORKDIR='${CODEX_WORKDIR}'`);
});
