// render-vrma-preview.mjs — render a .vrma applied to a VRM into a preview MP4 (+GIF).
// Standalone: give it a .vrma and a VRM, get a video of the avatar performing it.
// Uses the project's three-vrm stack via a headless WebGL browser, stepping the
// animation frame-by-frame (preview.html / src/preview.ts) → ffmpeg.
//
// Usage:
//   node tools/render-vrma-preview.mjs --vrma <path|/public-url> [--vrm <path|/public-url>]
//        [--out preview.mp4] [--fps 24] [--seconds N] [--width 640] [--height 800]
//        [--no-gif] [--keep-frames] [--bg '#14233a']
// Prints a JSON summary on stdout (frames, animated, file sizes).
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');

function parseArgs(argv) {
  const a = { fps: 24, width: 640, height: 800, gif: true, gifWidth: 360, gifFps: 0, contactSheet: false, out: 'preview.mp4', vrm: '/avatars/default.vrm', bg: '#14233a', keepFrames: false, seconds: 0, port: 5181 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--vrma') a.vrma = argv[++i];
    else if (k === '--vrm') a.vrm = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--fps') a.fps = Number(argv[++i]);
    else if (k === '--seconds') a.seconds = Number(argv[++i]);
    else if (k === '--width') a.width = Number(argv[++i]);
    else if (k === '--height') a.height = Number(argv[++i]);
    else if (k === '--gif-width') a.gifWidth = Number(argv[++i]);
    else if (k === '--gif-fps') a.gifFps = Number(argv[++i]);
    else if (k === '--bg') a.bg = argv[++i];
    else if (k === '--port') a.port = Number(argv[++i]);
    else if (k === '--no-gif') a.gif = false;
    else if (k === '--contact-sheet') a.contactSheet = true;
    else if (k === '--keep-frames') a.keepFrames = true;
  }
  if (!a.vrma) { console.error('error: --vrma is required'); process.exit(2); }
  return a;
}

// resolve a vrm/vrma arg to a vite-served URL; copy external files into public/ (temp)
const tmpCopies = [];
function toPublicUrl(arg, kind) {
  if (arg.startsWith('/') && fs.existsSync(path.join(PUBLIC, arg.replace(/^\//, '')))) return arg;
  const src = path.resolve(arg);
  if (!fs.existsSync(src)) { console.error(`error: ${kind} not found: ${arg}`); process.exit(2); }
  const dir = kind === 'vrm' ? 'avatars' : 'vrma';
  const dest = path.join(PUBLIC, dir, `__preview_tmp_${kind}${path.extname(src) || (kind === 'vrm' ? '.vrm' : '.vrma')}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  tmpCopies.push(dest);
  return '/' + path.relative(PUBLIC, dest).split(path.sep).join('/');
}

const args = parseArgs(process.argv.slice(2));
const procs = [];
const cleanup = () => {
  for (const p of procs) { try { p.kill('SIGTERM'); } catch {} }
  for (const f of tmpCopies) { try { fs.rmSync(f, { force: true }); } catch {} }
};

async function waitHttp(url, label, t = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) { try { if ((await fetch(url)).ok) return; } catch {} await sleep(400); }
  throw new Error('timeout waiting for ' + label);
}

const CANDS = [
  { headless: false, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--no-sandbox'] },
  { headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] },
];

async function main() {
  const vrmUrl = toPublicUrl(args.vrm, 'vrm');
  const vrmaUrl = toPublicUrl(args.vrma, 'vrma');
  const appUrl = `http://127.0.0.1:${args.port}/preview.html?vrm=${encodeURIComponent(vrmUrl)}&vrma=${encodeURIComponent(vrmaUrl)}&bg=${encodeURIComponent(args.bg)}`;

  procs.push(spawn('npx', ['vite', '--port', String(args.port), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' }));
  await waitHttp(`http://127.0.0.1:${args.port}/`, 'vite');

  let browser = null, page = null;
  for (const opt of CANDS) {
    try { browser = await chromium.launch(opt); } catch { continue; }
    page = await browser.newPage({ viewport: { width: args.width, height: args.height } });
    page.on('console', (m) => { if (m.type() === 'error') console.error('[preview page]', m.text()); });
    await page.goto(appUrl, { waitUntil: 'load', timeout: 120000 });
    const ok = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
    if (ok) break;
    await browser.close(); browser = null;
  }
  if (!browser) throw new Error('no WebGL2-capable browser available');

  // wait for the VRM+VRMA to load (or surface the page error)
  await page.waitForFunction(() => (window).__preview?.ready === true || (window).__preview?.error, null, { timeout: 90000 });
  const st = await page.evaluate(() => ({ ready: (window).__preview?.ready, error: (window).__preview?.error, durationSec: (window).__preview?.durationSec }));
  if (!st.ready) throw new Error('preview failed to load: ' + (st.error || 'unknown'));

  const dur = args.seconds > 0 ? Math.min(args.seconds, st.durationSec) : st.durationSec;
  const N = Math.max(2, Math.ceil(dur * args.fps));
  const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrma-preview-'));
  for (let i = 0; i < N; i++) {
    await page.evaluate((t) => (window).__preview.seek(t), i / args.fps);
    await page.screenshot({ path: path.join(framesDir, String(i).padStart(5, '0') + '.png') });
  }
  await browser.close();

  // animated? compare first vs middle captured frame
  const f0 = fs.readFileSync(path.join(framesDir, '00000.png'));
  const fm = fs.readFileSync(path.join(framesDir, String(Math.floor(N / 2)).padStart(5, '0') + '.png'));
  const animated = !f0.equals(fm);

  const out = path.resolve(args.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const mp4 = spawnSync('ffmpeg', ['-y', '-framerate', String(args.fps), '-i', path.join(framesDir, '%05d.png'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: 'ignore' });
  if (mp4.status !== 0) throw new Error('ffmpeg mp4 failed');

  let gifPath = null;
  if (args.gif) {
    gifPath = out.replace(/\.[^.]+$/, '') + '.gif';
    const pal = path.join(framesDir, 'palette.png');
    const gfps = args.gifFps > 0 ? args.gifFps : Math.min(15, args.fps);
    const gw = args.gifWidth;
    spawnSync('ffmpeg', ['-y', '-i', out, '-vf', `fps=${gfps},scale=${gw}:-1:flags=lanczos,palettegen`, pal], { stdio: 'ignore' });
    const g = spawnSync('ffmpeg', ['-y', '-i', out, '-i', pal, '-filter_complex', `fps=${gfps},scale=${gw}:-1:flags=lanczos[x];[x][1:v]paletteuse`, gifPath], { stdio: 'ignore' });
    if (g.status !== 0) gifPath = null;
  }

  // contact sheet: 12 evenly-spaced frames tiled into ONE png, so an AI can judge the
  // whole motion from a single static image (the Read tool only sees frame 0 of a gif).
  let contactPath = null;
  if (args.contactSheet) {
    contactPath = out.replace(/\.[^.]+$/, '') + '.contact.png';
    const step = Math.max(1, Math.floor((N - 1) / 11));
    const c = spawnSync('ffmpeg', ['-y', '-i', path.join(framesDir, '%05d.png'),
      '-vf', `select='not(mod(n,${step}))',scale=240:-1,tile=4x3:padding=6:color=0x14233a`,
      '-frames:v', '1', '-fps_mode', 'passthrough', contactPath], { stdio: 'ignore' });
    if (c.status !== 0 || !fs.existsSync(contactPath)) contactPath = null;
  }

  if (!args.keepFrames) fs.rmSync(framesDir, { recursive: true, force: true });

  const summary = {
    ok: true, vrm: vrmUrl, vrma: vrmaUrl, frames: N, fps: args.fps,
    durationSec: Number(dur.toFixed(2)), width: args.width, height: args.height, animated,
    mp4: out, mp4Bytes: fs.existsSync(out) ? fs.statSync(out).size : 0,
    gif: gifPath, gifBytes: gifPath && fs.existsSync(gifPath) ? fs.statSync(gifPath).size : 0,
    contactSheet: contactPath, contactBytes: contactPath && fs.existsSync(contactPath) ? fs.statSync(contactPath).size : 0,
    framesDir: args.keepFrames ? framesDir : null,
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

main()
  .then((s) => { cleanup(); process.exit(s.animated && s.mp4Bytes > 0 ? 0 : 1); })
  .catch((e) => { console.error('[render-vrma-preview]', e.message); console.log(JSON.stringify({ ok: false, error: e.message })); cleanup(); process.exit(1); });
