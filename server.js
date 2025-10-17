#!/usr/bin/env node
// Minimal OpenAI-compatible server that proxies to `codex exec --json`.
// No external deps: uses Node http module and child_process.

const http = require('http');
const { spawn } = require('child_process');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3040;
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CODEX_WORKDIR = process.env.CODEX_WORKDIR || process.cwd();
const EXEC_TIMEOUT_MS = process.env.EXEC_TIMEOUT_MS ? Number(process.env.EXEC_TIMEOUT_MS) : 120000; // 2 minutes
const PROMPT_MODE = process.env.PROMPT_MODE || 'raw_last'; // 'raw_last' | 'transcript'
const REQUIRE_API_KEY = !!process.env.REQUIRE_API_KEY; // when true, validate Authorization header
const API_KEY = process.env.API_KEY || '';
const FORCE_NON_STREAM = !!(process.env.FORCE_NON_STREAM || process.env.DISABLE_STREAM);
const FORCE_STREAM = !!process.env.FORCE_STREAM; // force SSE regardless of client payload

function json(res, statusCode, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-expose-headers': '*',
  });
  res.end(body);
}

function notFound(res) {
  json(res, 404, { error: { message: 'Not found' } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function validateAuth(req, res) {
  if (!REQUIRE_API_KEY) return true;
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) {
    json(res, 401, { error: { message: 'Missing Authorization Bearer token' } });
    return false;
  }
  const token = auth.slice('Bearer '.length).trim();
  if (!API_KEY || token !== API_KEY) {
    json(res, 401, { error: { message: 'Invalid API key' } });
    return false;
  }
  return true;
}

function messagesToPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  if (PROMPT_MODE === 'raw_last') {
    // Return only the last user message content for maximum fidelity.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === 'user') {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) {
          return m.content.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('');
        }
        if (m.content && typeof m.content === 'object' && m.content.text) return m.content.text;
      }
    }
    // Fallback to stringifying whatever the last message was
    const last = messages[messages.length - 1];
    return typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
  }
  // transcript mode (previous behavior)
  const lines = [];
  for (const m of messages) {
    if (!m || !m.role) continue;
    const role = String(m.role).toUpperCase();
    let content = '';
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('');
    } else if (m.content && typeof m.content === 'object' && m.content.text) {
      content = m.content.text;
    }
    lines.push(`${role}:\n${content}`);
  }
  return lines.join('\n\n');
}

function runCodexExec(taskPrompt) {
  // Use Codex JSONL mode to capture structured events.
  const args = ['exec', '--json', '--skip-git-repo-check', taskPrompt];
  const child = spawn(CODEX_BIN, args, {
    cwd: CODEX_WORKDIR,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let aggregatedStdout = '';
  let aggregatedStderr = '';
  let finalAssistant = '';
  let usage = undefined;
  let turnFailed = null;
  let spawnError = null;
  let buffer = '';

  child.on('error', (err) => {
    spawnError = err;
  });

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    aggregatedStdout += text;
    buffer += text;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        if (evt?.type === 'item.completed' && evt.item?.type === 'agent_message') {
          if (typeof evt.item.text === 'string') {
            finalAssistant = evt.item.text;
          }
        } else if (evt?.type === 'turn.completed' && evt.usage) {
          usage = evt.usage;
        } else if (evt?.type === 'turn.failed') {
          turnFailed = evt.error || { message: 'Codex turn failed' };
        }
      } catch (_) {
        // Ignore non-JSON lines in JSONL stream.
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    aggregatedStderr += chunk.toString('utf8');
  });

  let settled = false;
  const exited = new Promise((resolve) => {
    child.on('close', (code) => { settled = true; resolve({ code }); });
    child.on('error', (err) => { if (!settled) { settled = true; resolve({ code: -1, error: err }); } });
  });

  const killTimer = setTimeout(() => {
    if (!settled) {
      turnFailed = { message: `Timed out after ${EXEC_TIMEOUT_MS}ms` };
      try { child.kill('SIGKILL'); } catch {}
    }
  }, EXEC_TIMEOUT_MS);

  return { child, exited: exited.finally(() => clearTimeout(killTimer)), getFinal: () => ({ finalAssistant, usage, turnFailed, aggregatedStdout, aggregatedStderr, spawnError }) };
}

function handleModels(req, res) {
  const now = Math.floor(Date.now() / 1000);
  json(res, 200, {
    object: 'list',
    data: [
      { id: 'codex-exec', object: 'model', created: now, owned_by: 'local' },
    ],
  });
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function handleChatCompletions(req, res, body) {
  if (!validateAuth(req, res)) return;
  let payload;
  try {
    payload = JSON.parse(body || '{}');
  } catch (e) {
    return json(res, 400, { error: { message: 'Invalid JSON' } });
  }
  const { model, messages, stream } = payload;
  if (!model) return json(res, 400, { error: { message: 'model is required' } });
  if (model !== 'codex-exec') return json(res, 400, { error: { message: 'unsupported model' } });

  const prompt = messagesToPrompt(messages || []);
  const { exited, getFinal } = runCodexExec(prompt);

  // Heuristic: if client accepts SSE, treat as stream unless forced non-stream
  const accept = (req.headers['accept'] || '').toString();
  const clientWantsSSE = /text\/event-stream/i.test(accept);
  const wantStream = (FORCE_STREAM || Boolean(stream) || clientWantsSSE) && !FORCE_NON_STREAM;
  if (wantStream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type',
      'access-control-expose-headers': '*',
    });

    const startedAt = Math.floor(Date.now() / 1000);
    // Optional: initial role delta per OpenAI convention
    sseWrite(res, {
      id: `chatcmpl_${Date.now()}`,
      object: 'chat.completion.chunk',
      created: startedAt,
      model: model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });

    const { code } = await exited;
    const { finalAssistant, usage, turnFailed, spawnError, aggregatedStderr } = getFinal();

    if (spawnError) {
      sseWrite(res, { error: { message: `Failed to start codex: ${spawnError.message}. Set CODEX_BIN or update PATH.` } });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (turnFailed) {
      sseWrite(res, { error: { message: turnFailed.message || 'Codex failed' } });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (code !== 0) {
      const msg = (aggregatedStderr || '').trim() || `Codex exited with code ${code}`;
      sseWrite(res, { error: { message: msg } });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Send the whole assistant message as one delta
    sseWrite(res, {
      id: `chatcmpl_${Date.now()}`,
      object: 'chat.completion.chunk',
      created: startedAt,
      model: model,
      choices: [{ index: 0, delta: { content: finalAssistant || '' }, finish_reason: null }],
    });
    // Final chunk with finish_reason=stop for better client compatibility
    sseWrite(res, {
      id: `chatcmpl_${Date.now()}`,
      object: 'chat.completion.chunk',
      created: startedAt,
      model: model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    // Termination signal
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const { code } = await exited;
  const { finalAssistant, usage, turnFailed, spawnError, aggregatedStderr } = getFinal();
  if (spawnError) return json(res, 500, { error: { message: `Failed to start codex: ${spawnError.message}. Set CODEX_BIN or update PATH.` } });
  if (turnFailed) return json(res, 500, { error: { message: turnFailed.message || 'Codex failed' } });
  if (code !== 0) {
    const msg = (aggregatedStderr || '').trim() || `Codex exited with code ${code}`;
    return json(res, 500, { error: { message: msg, code } });
  }

  const created = Math.floor(Date.now() / 1000);
  const content = finalAssistant || '';
  json(res, 200, {
    id: `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') {
      // CORS preflight
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'Authorization, Content-Type',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/debug/check') {
      // Light-weight env introspection for troubleshooting
      return json(res, 200, {
        ok: true,
        model: 'codex-exec',
        prompt_mode: PROMPT_MODE,
        cwd: CODEX_WORKDIR,
        codex_bin: CODEX_BIN,
        auth_required: REQUIRE_API_KEY,
        stream_disabled: FORCE_NON_STREAM,
        stream_forced: FORCE_STREAM,
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return handleModels(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = await readBody(req);
      return handleChatCompletions(req, res, body);
    }
    return notFound(res);
  } catch (e) {
    return json(res, 500, { error: { message: e?.message || 'Internal error' } });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[codex-localhost] listening on http://127.0.0.1:${PORT}`);
  console.log(`[codex-localhost] Using CODEX_BIN='${CODEX_BIN}', CODEX_WORKDIR='${CODEX_WORKDIR}'`);
});
