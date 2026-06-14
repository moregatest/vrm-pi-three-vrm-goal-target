// Proof C + handless round — the FULL chain: handless-termal's `ht run-round`
// drives pi (local Qwen, via the non-invasive wrapper that loads the VRM tools),
// pi calls the semantic tools -> VRM API -> SSE -> the three-vrm browser runtime
// reacts live. We keep a real browser open the whole time, then screenshot it and
// assert the event log + DOM + transcript.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HT = '/Users/tung/Codes/handless-termal/bin/ht';
const RUN = path.join(ROOT, 'proofs', 'handless-run');
const WRAPPER_BIN = path.join(ROOT, 'bin');
const TRANSCRIPT = path.join(RUN, 'rounds', 'r1', 'vrm-character-0', 'transcript.md');
const API_PORT = Number(process.env.PROOF_API_PORT || 8970);
const VITE_PORT = Number(process.env.PROOF_VITE_PORT || 5180);
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const APP_URL = `http://127.0.0.1:${VITE_PORT}/`;
const EVENT_LOG = path.join(ROOT, 'events.handless.jsonl');
const SHOT = path.join(ROOT, 'proof-c-screenshot.png');
const HT_TIMEOUT_MS = Number(process.env.HT_TIMEOUT_MS || 720000);

const CANDIDATES = [
  { mode: 'headed-gpu', opts: { headless: false, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--no-sandbox'] } },
  { mode: 'headless-swiftshader', opts: { headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] } },
];

const procs = [];
function start(cmd, args, env) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'inherit' });
  procs.push(p); return p;
}
function cleanup() { for (const p of procs) { try { p.kill('SIGTERM'); } catch {} } }
async function waitFor(url, label, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const r = await fetch(url); if (r.ok) return; } catch {} await sleep(400); }
  throw new Error(`timeout waiting for ${label} (${url})`);
}

const result = {
  pass: false, browserMode: '', htExit: null, htTimedOut: false, htDurationMs: 0,
  screenshot: SHOT, eventLog: EVENT_LOG, transcriptPath: TRANSCRIPT,
  checks: {}, pixels: {}, state: {}, transcriptExcerpt: '',
};

function runHtRound() {
  return new Promise((resolve) => {
    const env = { ...process.env, PATH: `${WRAPPER_BIN}:${process.env.PATH}`, VRM_BASE_URL: API_BASE };
    const t0 = Date.now();
    const p = spawn('python3', [HT, 'run-round', '--run', RUN, '--round', '1'], { cwd: ROOT, env, stdio: 'inherit' });
    const killer = setTimeout(() => { result.htTimedOut = true; try { p.kill('SIGTERM'); } catch {} setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 4000); }, HT_TIMEOUT_MS);
    p.on('close', (code) => { clearTimeout(killer); result.htExit = code; result.htDurationMs = Date.now() - t0; resolve(code); });
  });
}

async function pixelCheck(page) {
  return page.evaluate(() => {
    const c = document.getElementById('canvas');
    const w = c.width, h = c.height;
    const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h;
    const ctx = tmp.getContext('2d'); ctx.drawImage(c, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    let nW = 0, nB = 0, n = 0, sum = 0, sumSq = 0; const seen = new Set();
    const step = 4 * Math.max(1, Math.floor((w * h) / 150000));
    for (let i = 0; i < data.length; i += step) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (r > 244 && g > 244 && b > 244) nW++; if (r < 11 && g < 11 && b < 11) nB++;
      sum += lum; sumSq += lum * lum; n++; seen.add((r >> 4) + ',' + (g >> 4) + ',' + (b >> 4));
    }
    const mean = sum / n, variance = sumSq / n - mean * mean;
    return { w, h, samples: n, nearWhitePct: nW / n, nearBlackPct: nB / n, std: Math.sqrt(Math.max(0, variance)), distinctColors: seen.size };
  });
}

async function main() {
  fs.writeFileSync(EVENT_LOG, '');
  start('node', ['server/vrm-api.mjs'], { VRM_API_PORT: String(API_PORT), VRM_EVENT_LOG: EVENT_LOG });
  start('npx', ['vite', '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'], { VITE_API_BASE: API_BASE });
  await waitFor(`${API_BASE}/vrm/health`, 'vrm-api');
  await waitFor(APP_URL, 'vite');

  let browser, page;
  for (const cand of CANDIDATES) {
    try { browser = await chromium.launch(cand.opts); } catch (e) { console.warn(`launch ${cand.mode} failed: ${e.message}`); continue; }
    result.browserMode = cand.mode;
    page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    page.on('console', (m) => console.log('[page]', m.type(), m.text()));
    await page.goto(APP_URL, { waitUntil: 'load', timeout: 120000 });
    const webgl2 = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
    if (!webgl2) { await browser.close(); browser = null; continue; }
    break;
  }
  if (!browser) throw new Error('no usable browser/WebGL2');

  await page.waitForFunction(() => window.__VRM_STATE__ && window.__VRM_STATE__.vrmLoaded === true, null, { timeout: 90000 });
  await page.waitForFunction(() => window.__VRM_STATE__ && window.__VRM_STATE__.sseConnected === true, null, { timeout: 20000 });
  console.log('[proof-c] browser ready & subscribed; launching ht run-round (pi via wrapper)…');

  await runHtRound();
  console.log(`[proof-c] ht run-round finished exit=${result.htExit} timedOut=${result.htTimedOut} (${Math.round(result.htDurationMs / 1000)}s)`);

  // give SSE a moment to settle the final state
  await sleep(1500);
  result.state = await page.evaluate(() => ({ ...window.__VRM_STATE__ }));

  const bbox = await page.locator('#canvas').boundingBox();
  if (bbox) await page.screenshot({ path: SHOT, clip: bbox });
  result.pixels = await pixelCheck(page);
  await browser.close();

  let log = [];
  try { log = fs.readFileSync(EVENT_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
  result.events = log;
  if (fs.existsSync(TRANSCRIPT)) {
    const t = fs.readFileSync(TRANSCRIPT, 'utf8');
    result.transcriptExcerpt = t.slice(0, 1600);
  }

  const px = result.pixels, s = result.state;
  Object.assign(result.checks, {
    logHappy: log.some((e) => e.type === 'expression' && (e.emotion || '').toLowerCase() === 'happy'),
    logWave: log.some((e) => e.type === 'motion' && (e.motion || '').toLowerCase() === 'wave'),
    logSay: log.some((e) => e.type === 'say' && (e.text || '').length > 0),
    domExprHappy: s.lastExpression === 'happy',
    domMotionWave: s.lastMotion === 'wave',
    domSaid: (s.lastSayText || '').length > 0,
    vrmLoaded: s.vrmLoaded === true,
    renderFramesGt10: s.renderFrames > 10,
    canvasNotEmpty: (px.nearWhitePct + px.nearBlackPct) < 0.98 && px.std > 8 && px.distinctColors > 12,
    transcriptExists: fs.existsSync(TRANSCRIPT) && result.transcriptExcerpt.length > 0,
  });
  result.failedChecks = Object.entries(result.checks).filter(([, v]) => v !== true).map(([k]) => k);
  // E2E pass = the event log proves pi called the tools AND the browser reacted live
  result.pass = result.checks.logHappy && result.checks.logWave && result.checks.logSay &&
    result.checks.domExprHappy && result.checks.domMotionWave && result.checks.domSaid &&
    result.checks.canvasNotEmpty && result.checks.transcriptExists;
}

main()
  .then(() => { console.log('\n=== PROOF C RESULT ===\n' + JSON.stringify(result, null, 2)); cleanup(); process.exit(result.pass ? 0 : 1); })
  .catch((e) => { console.error('[proof-c] error', e.message); result.failedChecks = Object.entries(result.checks).filter(([, v]) => v !== true).map(([k]) => k); console.log(JSON.stringify(result, null, 2)); cleanup(); process.exit(1); });
