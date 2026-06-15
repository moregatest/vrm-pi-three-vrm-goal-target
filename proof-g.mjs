// Proof G — the PROGRAMMATICALLY-GENERATED .vrma loads + plays in our runtime.
// Proves the "→ VRMA" back-end of the dance-video pipeline end to end:
// tools/make-vrma.mjs wrote public/vrma/generated_demo.vrma → the runtime loads it
// (realVrmaLoaded contains generated_dance), playing it animates the avatar
// (poseSignature changes), lastClipSource=vrma, canvas non-empty + screenshot.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const API_PORT = 8970, VITE_PORT = 5180;
const API_BASE = `http://127.0.0.1:${API_PORT}`, APP_URL = `http://127.0.0.1:${VITE_PORT}/`;
const SHOT = path.join(ROOT, 'proof-g-screenshot.png');
const CLIP = 'generated_dance';

const procs = [];
const start = (c, a, e) => { const p = spawn(c, a, { cwd: ROOT, env: { ...process.env, ...e }, stdio: 'inherit' }); procs.push(p); return p; };
const cleanup = () => { for (const p of procs) { try { p.kill('SIGTERM'); } catch {} } };
async function waitFor(u, l, t = 60000) { const t0 = Date.now(); while (Date.now() - t0 < t) { try { if ((await fetch(u)).ok) return; } catch {} await sleep(400); } throw new Error('timeout ' + l); }
async function post(p, b) { const r = await fetch(API_BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); if (!r.ok) throw new Error('POST ' + p + ' ' + r.status); return r.json(); }
const read = (page) => page.evaluate(() => ({ ...window.__VRM_STATE__ }));
const sampleSeries = (page, field, ms) => page.evaluate(async ([f, dur]) => { const s = []; const t0 = performance.now(); while (performance.now() - t0 < dur) { s.push(window.__VRM_STATE__[f] ?? 0); await new Promise((r) => requestAnimationFrame(r)); } return s; }, [field, ms]);

const CANDS = [
  { o: { headless: false, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--no-sandbox'] } },
  { o: { headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] } },
];
const result = { pass: false, clip: CLIP, checks: {}, samples: {}, screenshot: SHOT };

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
  start('node', ['server/vrm-api.mjs'], { VRM_API_PORT: String(API_PORT), VRM_EVENT_LOG: path.join(ROOT, 'events.proof-g.jsonl') });
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

  // our generated .vrma is in the manifest → the runtime should load it
  await page.waitForFunction((id) => (window.__VRM_STATE__?.realVrmaLoaded || []).includes(id), CLIP, { timeout: 30000 }).catch(() => {});
  result.samples.realVrmaLoaded = (await read(page)).realVrmaLoaded || [];
  result.checks.generatedVrmaLoaded = result.samples.realVrmaLoaded.includes(CLIP);

  // trigger it (gesture "dance" → selector picks generated_dance, a VRMA clip)
  await post('/vrm/motion', { motion: 'dance' });
  await page.waitForFunction((id) => { const s = window.__VRM_STATE__ || {}; return (s.realVrmaPlayed || []).includes(id) && s.lastClipSource === 'vrma'; }, CLIP, { timeout: 12000 }).catch(() => {});

  // sample pose while the generated clip plays → it animates the avatar
  const pose = await sampleSeries(page, 'poseSignature', 1200);
  const distinct = new Set(pose.map((x) => Math.round(x * 1e3))).size;
  result.samples.poseDistinct = distinct;
  result.samples.poseRange = Math.max(...pose) - Math.min(...pose);

  const s = await read(page);
  result.samples.after = { realVrmaPlayed: s.realVrmaPlayed, lastClipSource: s.lastClipSource, clientLog: (s.clientLog || []).slice(-4) };
  result.checks.generatedVrmaPlayed = (s.realVrmaPlayed || []).includes(CLIP);
  result.checks.lastClipSourceVrma = s.lastClipSource === 'vrma';
  result.checks.animatesWhilePlaying = distinct > 3 && (Math.max(...pose) - Math.min(...pose)) > 1e-2;

  await sleep(300);
  const bbox = await page.locator('#canvas').boundingBox();
  if (bbox) await page.screenshot({ path: SHOT, clip: bbox });
  const px = await pixels(page); result.pixels = px;
  result.checks.stillRenders = (px.nearWhitePct + px.nearBlackPct) < 0.98 && px.std > 8;

  await browser.close();
  result.failedChecks = Object.entries(result.checks).filter(([, v]) => v !== true).map(([k]) => k);
  result.pass = result.failedChecks.length === 0;
}

main()
  .then(() => { console.log('\n=== PROOF G RESULT ===\n' + JSON.stringify(result, null, 2)); cleanup(); process.exit(result.pass ? 0 : 1); })
  .catch((e) => { console.error('[proof-g] error', e.message); result.failedChecks = Object.entries(result.checks).filter(([, v]) => v !== true).map(([k]) => k); console.log(JSON.stringify(result, null, 2)); cleanup(); process.exit(1); });
