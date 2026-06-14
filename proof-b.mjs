// Proof B — the Pi agent (local Qwen 3.6 27B) reads AGENTS.md, chooses the
// semantic VRM tools, and actually calls them. The VRM API logs every call to
// JSONL in real time, so the event log proves the calls even if pi's buffered
// --mode json stdout is lost on a timeout.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PI_DIR = path.join(ROOT, 'pi');
const API_PORT = Number(process.env.PROOF_API_PORT || 8970);
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const EVENT_LOG = path.join(ROOT, 'events.proof-b.jsonl');
const PI_STDOUT = path.join(ROOT, 'proof-b-pi-stdout.jsonl');
const MODEL = process.env.PI_MODEL || 'HauhauCS/Qwen3.6-27B-Uncensored-HauhauCS-Balanced';
const PROMPT = process.env.PI_PROMPT || 'Greet me happily and give me a wave.';
const PI_TIMEOUT_MS = Number(process.env.PI_TIMEOUT_MS || 540000);

const result = {
  pass: false, model: MODEL, prompt: PROMPT, eventLog: EVENT_LOG, piStdout: PI_STDOUT,
  piExit: null, piDurationMs: 0, timedOut: false, toolCalls: [], checks: {},
};

let api;
async function waitHealth(timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(`${API_BASE}/vrm/health`); if (r.ok) return; } catch {}
    await sleep(300);
  }
  throw new Error('api health timeout');
}

function runPi() {
  return new Promise((resolve) => {
    const args = [
      '-e', 'pi/vrm-tools.ts',
      '--no-builtin-tools',
      '-t', 'vrm_say,vrm_expression,vrm_motion,vrm_reset',
      '--provider', 'llama-server',
      '--model', MODEL,
      '--thinking', 'off',
      '--no-session',
      '-p', PROMPT,
    ];
    const t0 = Date.now();
    // cwd is the parent so `-e pi/vrm-tools.ts` resolves; AGENTS.md lives in pi/.
    // Run from PI_DIR so AGENTS.md auto-loads; adjust the -e path accordingly.
    const p = spawn('pi', [
      '-e', 'vrm-tools.ts',
      '--no-builtin-tools',
      '-t', 'vrm_say,vrm_expression,vrm_motion,vrm_reset',
      '--provider', 'llama-server',
      '--model', MODEL,
      '--thinking', 'off',
      '--no-session',
      '-p', PROMPT,
    ], { cwd: PI_DIR, env: { ...process.env, VRM_BASE_URL: API_BASE } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    const killer = setTimeout(() => {
      result.timedOut = true;
      try { p.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 3000);
    }, PI_TIMEOUT_MS);
    p.on('close', (code) => {
      clearTimeout(killer);
      result.piExit = code;
      result.piDurationMs = Date.now() - t0;
      fs.writeFileSync(PI_STDOUT, out);
      if (err) fs.writeFileSync(PI_STDOUT + '.stderr.txt', err);
      resolve({ out, err, code });
    });
  });
}

function parseToolCalls(out) {
  const calls = [];
  for (const line of out.split('\n')) {
    const s = line.trim(); if (!s) continue;
    let o; try { o = JSON.parse(s); } catch { continue; }
    if (o && (o.type === 'tool_execution_start' || o.type === 'tool_execution_end')) {
      calls.push({ type: o.type, tool: o.toolName, args: o.args, isError: o.isError });
    }
  }
  return calls;
}

async function main() {
  fs.writeFileSync(EVENT_LOG, '');
  api = spawn('node', ['server/vrm-api.mjs'], {
    cwd: ROOT, env: { ...process.env, VRM_API_PORT: String(API_PORT), VRM_EVENT_LOG: EVENT_LOG },
    stdio: 'inherit',
  });
  await waitHealth();
  console.log(`[proof-b] running pi (model=${MODEL}, timeout=${PI_TIMEOUT_MS}ms)…`);
  const { out } = await runPi();
  result.toolCalls = parseToolCalls(out);

  let log = [];
  try { log = fs.readFileSync(EVENT_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
  result.events = log;
  result.checks.logHappy = log.some((e) => e.type === 'expression' && (e.emotion || '').toLowerCase() === 'happy');
  result.checks.logWave = log.some((e) => e.type === 'motion' && (e.motion || '').toLowerCase() === 'wave');
  result.checks.logSay = log.some((e) => e.type === 'say' && (e.text || '').length > 0);
  result.pass = result.checks.logHappy && result.checks.logWave && result.checks.logSay;

  try { api.kill('SIGTERM'); } catch {}
}

main()
  .then(() => { console.log('\n=== PROOF B RESULT ===\n' + JSON.stringify(result, null, 2)); process.exit(result.pass ? 0 : 1); })
  .catch((e) => { console.error('[proof-b] error', e.message); try { api.kill('SIGTERM'); } catch {} console.log(JSON.stringify(result, null, 2)); process.exit(1); });
