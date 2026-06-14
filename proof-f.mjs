// Proof F — VRMA performance clip layer (revised hybrid spec).
// Asserts: real VRM loaded; >=1 REAL VRMA clip loaded AND played; >=3 procedural
// clips registered; idle procedural active BEFORE any agent event; agent path
// (happy + wave + say) drives it; runtime state proves realVrmaPlayed>=1 &
// proceduralActive>=1 & lastClipSource=vrma; canvas non-empty + screenshot.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const API_PORT = 8970, VITE_PORT = 5180;
const API_BASE = `http://127.0.0.1:${API_PORT}`, APP_URL = `http://127.0.0.1:${VITE_PORT}/`;
const SHOT = path.join(ROOT, 'proof-f-screenshot.png');

const procs = [];
const start = (c, a, e) => { const p = spawn(c, a, { cwd: ROOT, env: { ...process.env, ...e }, stdio: 'inherit' }); procs.push(p); return p; };
const cleanup = () => { for (const p of procs) { try { p.kill('SIGTERM'); } catch {} } };
async function waitFor(u, l, t = 60000) { const t0 = Date.now(); while (Date.now() - t0 < t) { try { if ((await fetch(u)).ok) return; } catch {} await sleep(400); } throw new Error('timeout ' + l); }
async function post(p, b) { const r = await fetch(API_BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); if (!r.ok) throw new Error('POST ' + p + ' ' + r.status); return r.json(); }
const read = (page) => page.evaluate(() => ({ ...window.__VRM_STATE__ }));

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
  start('node', ['server/vrm-api.mjs'], { VRM_API_PORT: String(API_PORT), VRM_EVENT_LOG: path.join(ROOT, 'events.proof-f.jsonl') });
  start('npx', ['vite', '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'], { VITE_API_BASE: API_BASE });
  await waitFor(API_BASE + '/vrm/health', 'api'); await waitFor(APP_URL, 'vite');

  // manifest: >=3 procedural clips registered
  let manifest = { clips: [] };
  try { manifest = await (await fetch(APP_URL + 'vrma/clips.json')).json(); } catch {}
  const procCount = (manifest.clips || []).filter((c) => c.source?.kind === 'procedural').length;
  const vrmaCount = (manifest.clips || []).filter((c) => c.source?.kind === 'vrma').length;
  result.samples.manifest = { procedural: procCount, vrma: vrmaCount };
  result.checks.proceduralRegistered3 = procCount >= 3;
  result.checks.vrmaInManifest = vrmaCount >= 1;

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

  // idle procedural active BEFORE any agent event
  const pre = await read(page);
  result.samples.before = { proceduralActive: pre.proceduralActive, renderFrames: pre.renderFrames };
  result.checks.idleProceduralBeforeEvent = (pre.proceduralActive?.length || 0) >= 1;
  result.checks.renderFrames = pre.renderFrames > 10;

  // >=1 real VRMA loaded (loads shortly after the VRM)
  await page.waitForFunction(() => (window.__VRM_STATE__?.realVrmaLoaded?.length || 0) >= 1, null, { timeout: 30000 }).catch(() => {});
  result.samples.realVrmaLoaded = (await read(page)).realVrmaLoaded || [];
  result.checks.realVrmaLoaded = result.samples.realVrmaLoaded.length >= 1;

  // agent path: happy + wave + say
  await post('/vrm/expression', { emotion: 'happy' });
  await post('/vrm/motion', { motion: 'wave' });
  await post('/vrm/say', { text: '嗨,我是 Mira,很高興見到你!' });

  await page.waitForFunction(() => {
    const s = window.__VRM_STATE__ || {};
    return (s.realVrmaPlayed?.length || 0) >= 1 && s.lastClipSource === 'vrma' && s.lastExpression === 'happy' && (s.lastSayText || '').length > 0;
  }, null, { timeout: 15000 }).catch(() => {});

  const s = await read(page);
  result.samples.after = { realVrmaPlayed: s.realVrmaPlayed, lastClipSource: s.lastClipSource, lastExpression: s.lastExpression, lastSayText: s.lastSayText, proceduralActive: s.proceduralActive, clientLog: s.clientLog };
  result.checks.realVrmaPlayed = (s.realVrmaPlayed?.length || 0) >= 1;
  result.checks.lastClipSourceVrma = s.lastClipSource === 'vrma';
  result.checks.proceduralActiveAfter = (s.proceduralActive?.length || 0) >= 1;
  result.checks.exprHappy = s.lastExpression === 'happy';
  result.checks.said = (s.lastSayText || '').length > 0;

  await sleep(500);
  const bbox = await page.locator('#canvas').boundingBox();
  if (bbox) await page.screenshot({ path: SHOT, clip: bbox });
  const px = await pixels(page); result.pixels = px;
  result.checks.stillRenders = (px.nearWhitePct + px.nearBlackPct) < 0.98 && px.std > 8;

  await browser.close();
  result.failedChecks = Object.entries(result.checks).filter(([, v]) => v !== true).map(([k]) => k);
  result.pass = result.failedChecks.length === 0;
}

main()
  .then(() => { console.log('\n=== PROOF F RESULT ===\n' + JSON.stringify(result, null, 2)); cleanup(); process.exit(result.pass ? 0 : 1); })
  .catch((e) => { console.error('[proof-f] error', e.message); result.failedChecks = Object.entries(result.checks).filter(([, v]) => v !== true).map(([k]) => k); console.log(JSON.stringify(result, null, 2)); cleanup(); process.exit(1); });
