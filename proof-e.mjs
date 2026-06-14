// Proof E — the avatar is "alive", not just triggering poses.
// Verifies (via in-page high-frequency samplers, robust to driver latency):
//   1. idle micro-motion: poseSignature keeps changing with NO events (breathing/sway/head)
//   2. natural blink: blinkCount increases on its own
//   3. expression is a gradual ramp, not a hard switch
//   4. actions blend IN (weight ramps 0→~1), not an instant jump
//   5. speech drives a changing viseme mouth
//   6. still renders (pixel check) + screenshot
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const API_PORT = 8970, VITE_PORT = 5180;
const API_BASE = `http://127.0.0.1:${API_PORT}`, APP_URL = `http://127.0.0.1:${VITE_PORT}/`;
const SHOT = path.join(ROOT, 'proof-e-screenshot.png');

const procs = [];
const start = (c, a, e) => { const p = spawn(c, a, { cwd: ROOT, env: { ...process.env, ...e }, stdio: 'inherit' }); procs.push(p); return p; };
const cleanup = () => { for (const p of procs) { try { p.kill('SIGTERM'); } catch {} } };
async function waitFor(u, l, t = 60000) { const t0 = Date.now(); while (Date.now() - t0 < t) { try { if ((await fetch(u)).ok) return; } catch {} await sleep(400); } throw new Error('timeout ' + l); }
async function post(p, b) { const r = await fetch(API_BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); if (!r.ok) throw new Error('POST ' + p + ' ' + r.status); return r.json(); }
const read = (page) => page.evaluate(() => ({ ...window.__VRM_STATE__ }));
const sampleSeries = (page, field, ms) => page.evaluate(async ([f, dur]) => {
  const s = []; const t0 = performance.now();
  while (performance.now() - t0 < dur) { s.push(window.__VRM_STATE__[f] ?? 0); await new Promise((r) => requestAnimationFrame(r)); }
  return s;
}, [field, ms]);

const CANDS = [
  { o: { headless: false, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--no-sandbox'] } },
  { o: { headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] } },
];
const result = { pass: false, checks: {}, samples: {}, screenshot: SHOT };

async function pixels(page) {
  return page.evaluate(() => {
    const c = document.getElementById('canvas'); const w = c.width, h = c.height;
    const t = document.createElement('canvas'); t.width = w; t.height = h;
    const x = t.getContext('2d'); x.drawImage(c, 0, 0);
    const d = x.getImageData(0, 0, w, h).data;
    let nW = 0, nB = 0, n = 0, sum = 0, sq = 0;
    const st = 4 * Math.max(1, Math.floor(w * h / 150000));
    for (let i = 0; i < d.length; i += st) { const r = d[i], g = d[i + 1], b = d[i + 2]; const L = .299 * r + .587 * g + .114 * b; if (r > 244 && g > 244 && b > 244) nW++; if (r < 11 && g < 11 && b < 11) nB++; sum += L; sq += L * L; n++; }
    const m = sum / n; return { nearWhitePct: nW / n, nearBlackPct: nB / n, std: Math.sqrt(Math.max(0, sq / n - m * m)) };
  });
}

async function main() {
  start('node', ['server/vrm-api.mjs'], { VRM_API_PORT: String(API_PORT), VRM_EVENT_LOG: path.join(ROOT, 'events.proof-e.jsonl') });
  start('npx', ['vite', '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'], { VITE_API_BASE: API_BASE });
  await waitFor(API_BASE + '/vrm/health', 'api'); await waitFor(APP_URL, 'vite');

  let browser, page;
  for (const c of CANDS) {
    try { browser = await chromium.launch(c.o); } catch { continue; }
    page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    page.on('console', (m) => console.log('[page]', m.type(), m.text()));
    await page.goto(APP_URL, { waitUntil: 'load', timeout: 120000 });
    if (!(await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2')))) { await browser.close(); browser = null; continue; }
    break;
  }
  if (!browser) throw new Error('no webgl2 browser');
  await page.waitForFunction(() => window.__VRM_STATE__?.vrmLoaded === true, null, { timeout: 90000 });
  await sleep(500);

  // 1. idle micro-motion (no events sent)
  const pose = await sampleSeries(page, 'poseSignature', 450);
  const distinct = new Set(pose.map((x) => Math.round(x * 1e4))).size;
  result.samples.idle = { distinct, range: Math.max(...pose) - Math.min(...pose) };
  result.checks.idleMicroMotion = distinct > 3 && (Math.max(...pose) - Math.min(...pose)) > 1e-3;

  // 2. natural blink
  let bc = 0; const t0 = Date.now();
  while (Date.now() - t0 < 9000) { bc = (await read(page)).blinkCount ?? 0; if (bc >= 1) break; await sleep(300); }
  result.samples.blinkCount = bc; result.checks.blink = bc >= 1;

  // 3. expression gradual ramp (not hard switch)
  await post('/vrm/expression', { emotion: 'happy' });
  const es = await sampleSeries(page, 'exprHappy', 900);
  result.samples.expr = { max: Math.max(...es), midRampSamples: es.filter((v) => v > 0.05 && v < 0.7).length };
  result.checks.expressionRamp = Math.max(...es) > 0.6 && es.some((v) => v > 0.05 && v < 0.7);

  // 4. action blend-in (weight ramps, not instant)
  await post('/vrm/motion', { motion: 'wave' });
  const ws = await sampleSeries(page, 'actionWeight', 700);
  result.samples.action = { name: (await read(page)).actionName, max: Math.max(...ws), midRampSamples: ws.filter((w) => w > 0.05 && w < 0.7).length };
  result.checks.actionBlend = Math.max(...ws) > 0.8 && ws.some((w) => w > 0.05 && w < 0.7) && (await read(page)).actionName === 'wave';

  // 5. speech → changing visemes
  const vc0 = (await read(page)).visemeChanges ?? 0;
  await post('/vrm/say', { text: 'Hello there, it is so nice to see you again today my friend!' });
  await sleep(1400);
  const vc1 = (await read(page)).visemeChanges ?? 0;
  result.samples.viseme = { before: vc0, after: vc1, delta: vc1 - vc0 };
  result.checks.mouthVisemes = (vc1 - vc0) >= 3;

  // 6. still renders + screenshot
  await sleep(300);
  const bbox = await page.locator('#canvas').boundingBox();
  if (bbox) await page.screenshot({ path: SHOT, clip: bbox });
  const px = await pixels(page); result.pixels = px;
  result.checks.stillRenders = (px.nearWhitePct + px.nearBlackPct) < 0.98 && px.std > 8;
  result.samples.finalState = await read(page);

  await browser.close();
  result.failedChecks = Object.entries(result.checks).filter(([, v]) => v !== true).map(([k]) => k);
  result.pass = result.failedChecks.length === 0;
}

main()
  .then(() => { console.log('\n=== PROOF E RESULT ===\n' + JSON.stringify(result, null, 2)); cleanup(); process.exit(result.pass ? 0 : 1); })
  .catch((e) => { console.error('[proof-e] error', e.message); result.failedChecks = Object.entries(result.checks).filter(([, v]) => v !== true).map(([k]) => k); console.log(JSON.stringify(result, null, 2)); cleanup(); process.exit(1); });
