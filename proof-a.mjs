// Proof A — the three-vrm renderer actually reacts to VRM API events, end to end.
//
// Starts the VRM API + the Vite dev server, opens a REAL browser (headed/real-GPU
// first, headless+SwiftShader fallback), hard-asserts WebGL2, POSTs happy/wave/say
// events to the API, waits for the runtime DOM state to reflect them, screenshots
// the canvas region, and runs a pixel check that rejects an all-white / all-black /
// visually empty canvas. Verifies the API JSONL log captured the calls too.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const API_PORT = Number(process.env.PROOF_API_PORT || 8970);
const VITE_PORT = Number(process.env.PROOF_VITE_PORT || 5180);
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const APP_URL = `http://127.0.0.1:${VITE_PORT}/`;
const EVENT_LOG = path.join(ROOT, 'events.proof-a.jsonl');
const SHOT = path.join(ROOT, 'proof-a-screenshot.png');
const SAY_TEXT = 'Hello! So happy to see you!';

const CANDIDATES = [
  { mode: 'headed-gpu', opts: { headless: false,
      args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--no-sandbox'] } },
  { mode: 'headless-swiftshader', opts: { headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
             '--ignore-gpu-blocklist', '--no-sandbox'] } },
];

const procs = [];
function start(cmd, args, env) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'inherit' });
  procs.push(p);
  return p;
}
function cleanup() { for (const p of procs) { try { p.kill('SIGTERM'); } catch {} } }

async function waitFor(url, label, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await sleep(400);
  }
  throw new Error(`timeout waiting for ${label} (${url})`);
}
async function post(p, body) {
  const r = await fetch(`${API_BASE}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(`POST ${p} -> ${r.status}`);
  return r.json();
}

const result = {
  pass: false, browserMode: '', checks: {}, failedChecks: [],
  pixels: {}, state: {}, screenshot: SHOT, eventLog: EVENT_LOG,
};

// runs the full browser proof against an already-launched browser; throws
// {retry:true} if WebGL2 is unavailable (so the caller tries the next candidate)
async function runProof(browser) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  page.on('console', (m) => console.log('[page]', m.type(), m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto(APP_URL, { waitUntil: 'load', timeout: 120000 });

  const webgl2 = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
  if (!webgl2) { await page.close(); const e = new Error('no-webgl2'); e.retry = true; throw e; }
  result.checks.webgl2Context = true;

  await page.waitForFunction(() => window.__VRM_STATE__ && window.__VRM_STATE__.vrmLoaded === true,
    null, { timeout: 90000 });
  await page.waitForFunction(() => window.__VRM_STATE__ && window.__VRM_STATE__.sseConnected === true,
    null, { timeout: 20000 });

  // drive the three semantic events through the API (forwarded to the browser by SSE)
  await post('/vrm/expression', { emotion: 'happy' });
  await post('/vrm/motion', { motion: 'wave' });
  await post('/vrm/say', { text: SAY_TEXT });

  await page.waitForFunction(
    (say) => {
      const s = window.__VRM_STATE__ || {};
      return s.lastExpression === 'happy' && s.lastMotion === 'wave' &&
             s.lastSayText === say && s.renderFrames > 10;
    },
    SAY_TEXT, { timeout: 20000 },
  );
  await sleep(800); // let the wave animate before the screenshot

  result.state = await page.evaluate(() => ({ ...window.__VRM_STATE__ }));

  const bbox = await page.locator('#canvas').boundingBox();
  result.checks.canvasBBoxNonZero = !!bbox && bbox.width > 0 && bbox.height > 0;
  if (bbox) await page.screenshot({ path: SHOT, clip: bbox });

  const px = await page.evaluate(() => {
    const c = document.getElementById('canvas');
    const w = c.width, h = c.height;
    const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    let nW = 0, nB = 0, n = 0, sum = 0, sumSq = 0;
    const seen = new Set();
    const step = 4 * Math.max(1, Math.floor((w * h) / 150000));
    for (let i = 0; i < data.length; i += step) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (r > 244 && g > 244 && b > 244) nW++;
      if (r < 11 && g < 11 && b < 11) nB++;
      sum += lum; sumSq += lum * lum; n++;
      seen.add((r >> 4) + ',' + (g >> 4) + ',' + (b >> 4));
    }
    const mean = sum / n, variance = sumSq / n - mean * mean;
    return { w, h, samples: n, nearWhitePct: nW / n, nearBlackPct: nB / n,
             std: Math.sqrt(Math.max(0, variance)), distinctColors: seen.size };
  });
  result.pixels = px;

  await page.close();

  // event-log proof (the API forwarded AND logged)
  const log = fs.readFileSync(EVENT_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const s = result.state;
  Object.assign(result.checks, {
    canvasInternalSize: px.w > 0 && px.h > 0,
    notWhiteOrBlack: (px.nearWhitePct + px.nearBlackPct) < 0.98,
    hasVariance: px.std > 8 && px.distinctColors > 12,
    vrmLoaded: s.vrmLoaded === true,
    renderFramesGt10: s.renderFrames > 10,
    exprHappy: s.lastExpression === 'happy',
    motionWave: s.lastMotion === 'wave',
    saidSomething: (s.lastSayText || '').length > 0,
    webglOK: s.webglOK === true,
    logHappy: log.some((e) => e.type === 'expression' && e.emotion === 'happy'),
    logWave: log.some((e) => e.type === 'motion' && e.motion === 'wave'),
    logSay: log.some((e) => e.type === 'say' && (e.text || '').length > 0),
  });
}

async function main() {
  fs.writeFileSync(EVENT_LOG, '');
  start('node', ['server/vrm-api.mjs'], { VRM_API_PORT: String(API_PORT), VRM_EVENT_LOG: EVENT_LOG });
  start('npx', ['vite', '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'],
    { VITE_API_BASE: API_BASE });
  await waitFor(`${API_BASE}/vrm/health`, 'vrm-api');
  await waitFor(APP_URL, 'vite');

  let lastErr;
  for (const cand of CANDIDATES) {
    let browser;
    try { browser = await chromium.launch(cand.opts); }
    catch (e) { lastErr = e; console.warn(`[proof-a] launch ${cand.mode} failed: ${e.message}`); continue; }
    result.browserMode = cand.mode;
    try {
      await runProof(browser);
      await browser.close();
      break; // got a usable browser and finished the checks
    } catch (e) {
      try { await browser.close(); } catch {}
      if (e && e.retry) { lastErr = e; console.warn(`[proof-a] ${cand.mode}: ${e.message}, trying next`); continue; }
      throw e; // real assertion/runtime failure — do not mask by switching browser
    }
  }
  if (!result.checks.webgl2Context) throw lastErr || new Error('no usable browser/WebGL2');

  result.failedChecks = Object.entries(result.checks).filter(([, v]) => v !== true).map(([k]) => k);
  result.pass = result.failedChecks.length === 0;
}

main()
  .then(() => {
    console.log('\n=== PROOF A RESULT ===\n' + JSON.stringify(result, null, 2));
    cleanup();
    process.exit(result.pass ? 0 : 1);
  })
  .catch((e) => {
    console.error('\n[proof-a] ERROR:', e.message);
    result.failedChecks = Object.entries(result.checks).filter(([, v]) => v !== true).map(([k]) => k);
    console.log(JSON.stringify(result, null, 2));
    cleanup();
    process.exit(1);
  });
