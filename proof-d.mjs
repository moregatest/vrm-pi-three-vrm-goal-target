// Proof D — runtime VRM swap works in the browser (the same frontend the Tauri
// app uses). Starts API + Vite, opens a real-GPU browser, waits for the default
// avatar, then swaps to a different one via POST /vrm/load and asserts the avatar
// changed AND the canvas still renders (pixel check) + screenshot.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const API_PORT = 8970, VITE_PORT = 5180;
const API_BASE = `http://127.0.0.1:${API_PORT}`, APP_URL = `http://127.0.0.1:${VITE_PORT}/`;
const SHOT = path.join(ROOT, 'proof-d-screenshot.png');

const procs = [];
const start = (c, a, e) => { const p = spawn(c, a, { cwd: ROOT, env: { ...process.env, ...e }, stdio: 'inherit' }); procs.push(p); return p; };
const cleanup = () => { for (const p of procs) { try { p.kill('SIGTERM'); } catch {} } };
async function waitFor(u, l, t = 60000) { const t0 = Date.now(); while (Date.now() - t0 < t) { try { if ((await fetch(u)).ok) return; } catch {} await sleep(400); } throw new Error('timeout ' + l); }
async function post(p, b) { const r = await fetch(API_BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); if (!r.ok) throw new Error('POST ' + p + ' ' + r.status); return r.json(); }

const CANDS = [
  { m: 'headed-gpu', o: { headless: false, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--no-sandbox'] } },
  { m: 'headless-sw', o: { headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] } },
];
const result = { pass: false, browserMode: '', checks: {}, avatars: [], before: '', after: '', screenshot: SHOT };

async function pixels(page) {
  return page.evaluate(() => {
    const c = document.getElementById('canvas'); const w = c.width, h = c.height;
    const t = document.createElement('canvas'); t.width = w; t.height = h;
    const x = t.getContext('2d'); x.drawImage(c, 0, 0);
    const d = x.getImageData(0, 0, w, h).data;
    let nW = 0, nB = 0, n = 0, sum = 0, sq = 0; const seen = new Set();
    const st = 4 * Math.max(1, Math.floor(w * h / 150000));
    for (let i = 0; i < d.length; i += st) { const r = d[i], g = d[i + 1], b = d[i + 2]; const L = .299 * r + .587 * g + .114 * b; if (r > 244 && g > 244 && b > 244) nW++; if (r < 11 && g < 11 && b < 11) nB++; sum += L; sq += L * L; n++; seen.add((r >> 4) + ',' + (g >> 4) + ',' + (b >> 4)); }
    const mean = sum / n; return { w, h, nearWhitePct: nW / n, nearBlackPct: nB / n, std: Math.sqrt(Math.max(0, sq / n - mean * mean)), distinctColors: seen.size };
  });
}

async function main() {
  start('node', ['server/vrm-api.mjs'], { VRM_API_PORT: String(API_PORT), VRM_EVENT_LOG: path.join(ROOT, 'events.proof-d.jsonl') });
  start('npx', ['vite', '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'], { VITE_API_BASE: API_BASE });
  await waitFor(API_BASE + '/vrm/health', 'api'); await waitFor(APP_URL, 'vite');

  result.avatars = await (await fetch(API_BASE + '/vrm/avatars')).json();
  result.checks.twoAvatars = result.avatars.length >= 2;

  let browser, page;
  for (const c of CANDS) {
    try { browser = await chromium.launch(c.o); } catch { continue; }
    result.browserMode = c.m;
    page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    page.on('console', (m) => console.log('[page]', m.type(), m.text()));
    await page.goto(APP_URL, { waitUntil: 'load', timeout: 120000 });
    if (!(await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2')))) { await browser.close(); browser = null; continue; }
    break;
  }
  if (!browser) throw new Error('no webgl2 browser');

  await page.waitForFunction(() => window.__VRM_STATE__?.vrmLoaded === true, null, { timeout: 90000 });
  result.before = await page.evaluate(() => window.__VRM_STATE__.currentAvatar);
  const px1 = await pixels(page);

  const target = result.avatars.find((a) => !result.before.endsWith(a)) || result.avatars[result.avatars.length - 1];
  result.target = target;
  await post('/vrm/load', { name: target });
  await page.waitForFunction((t) => { const s = window.__VRM_STATE__; return s.vrmLoaded && s.currentAvatar.endsWith(t); }, target, { timeout: 60000 });
  await sleep(900);
  result.after = await page.evaluate(() => window.__VRM_STATE__.currentAvatar);
  const px2 = await pixels(page);
  const bbox = await page.locator('#canvas').boundingBox();
  if (bbox) await page.screenshot({ path: SHOT, clip: bbox });

  result.pixelsBefore = px1; result.pixelsAfter = px2;
  result.checks.swapped = result.before !== result.after && result.after.includes(target);
  result.checks.stillRenders = (px2.nearWhitePct + px2.nearBlackPct) < 0.98 && px2.std > 8 && px2.distinctColors > 12;
  await browser.close();

  result.failedChecks = Object.entries(result.checks).filter(([, v]) => v !== true).map(([k]) => k);
  result.pass = result.failedChecks.length === 0;
}

main()
  .then(() => { console.log('\n=== PROOF D RESULT ===\n' + JSON.stringify(result, null, 2)); cleanup(); process.exit(result.pass ? 0 : 1); })
  .catch((e) => { console.error('[proof-d] error', e.message); result.failedChecks = Object.entries(result.checks).filter(([, v]) => v !== true).map(([k]) => k); console.log(JSON.stringify(result, null, 2)); cleanup(); process.exit(1); });
