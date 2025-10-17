#!/usr/bin/env node
// CLI: forward a single question to local codex and print the final agent message.
const { spawn } = require('child_process');

const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CODEX_WORKDIR = process.env.CODEX_WORKDIR || process.cwd();

function getQuestionFromArgsOrStdin() {
  const args = process.argv.slice(2);
  if (args.length > 0) return Promise.resolve(args.join(' '));
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

function run(question) {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, ['exec', '--json', '--skip-git-repo-check', question], {
      cwd: CODEX_WORKDIR,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    let buffer = '';
    let finalAssistant = '';

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
          }
        } catch {}
      }
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        // Even on non-zero, we still print what we captured.
      }
      resolve(finalAssistant || '');
    });
  });
}

(async () => {
  const q = await getQuestionFromArgsOrStdin();
  if (!q) {
    console.error('Usage: ask-codex "your question"');
    process.exit(2);
  }
  try {
    const out = await run(q);
    process.stdout.write(out + (out.endsWith('\n') ? '' : '\n'));
  } catch (e) {
    console.error(e?.message || String(e));
    process.exit(1);
  }
})();

