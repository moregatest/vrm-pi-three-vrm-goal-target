// video-to-vrma.mjs — end-to-end: a (specifiable) dance video → a .vrma + a preview.
//   <YouTube URL | local video file>
//     → yt-dlp (if URL) → ffmpeg frames → MediaPipe pose → retarget → .vrma
//     → render-vrma-preview → preview.mp4 (+ .gif)
// Mac-ready (yt-dlp/ffmpeg/node + a Python venv with mediapipe; Apple Silicon, no CUDA).
//
// Usage:
//   node tools/video-to-vrma.mjs <url|file> [--out-dir DIR] [--name NAME]
//        [--start FRAME] [--len FRAMES] [--fps 30] [--vrm <path|/url>]
//        [--no-preview] [--python <py with mediapipe>] [--keep-frames]
//
// ⚠ Licensing: motion derived from someone else's video may carry video/choreography
//   rights — keep --out-dir products LOCAL; don't redistribute. (See docs/dance-video-to-vrma-plan.md §9.)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOOLS = path.join(ROOT, 'tools');

function parseArgs(argv) {
  const a = { outDir: path.join(ROOT, '.vrma-out'), name: 'dance', start: 0, len: 0, fps: 30, vrm: '/avatars/default.vrm', preview: true, python: '', keepFrames: false, contactSheet: true, engine: 'kalidokit', retarget: [] };
  a.input = argv[0] && !argv[0].startsWith('--') ? argv[0] : '';
  const boolRt = new Set(['--flip-x', '--flip-y', '--flip-z', '--mirror', '--legs', '--hips', '--flat-hips', '--no-legs']);
  const valRt = new Set(['--smooth', '--damp-head', '--damp-spine']);
  for (let i = a.input ? 1 : 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--out-dir') a.outDir = path.resolve(argv[++i]);
    else if (k === '--name') a.name = argv[++i];
    else if (k === '--start') a.start = Number(argv[++i]);
    else if (k === '--len') a.len = Number(argv[++i]);
    else if (k === '--fps') a.fps = Number(argv[++i]);
    else if (k === '--vrm') a.vrm = argv[++i];
    else if (k === '--python') a.python = argv[++i];
    else if (k === '--no-preview') a.preview = false;
    else if (k === '--no-contact-sheet') a.contactSheet = false;
    else if (k === '--engine') a.engine = argv[++i];           // kalidokit (default) | simple
    else if (k === '--keep-frames') a.keepFrames = true;
    else if (boolRt.has(k)) a.retarget.push(k);                 // retarget tuning → make-vrma-from-pose
    else if (valRt.has(k)) a.retarget.push(k, argv[++i]);
  }
  return a;
}

const run = (cmd, args, opts = {}) => {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8', ...opts });
  if (r.status !== 0) { console.error(`\n✗ step failed: ${cmd} (exit ${r.status})`); process.exit(1); }
  return r.stdout || '';
};

function findPython(explicit) {
  const cands = [explicit, process.env.VRMA_PYTHON, '/tmp/vrma-mocap-venv/bin/python',
    path.join(ROOT, '.venv-mocap/bin/python'), 'python3'].filter(Boolean);
  for (const py of cands) {
    const r = spawnSync(py, ['-c', 'import mediapipe'], { stdio: 'ignore' });
    if (r.status === 0) return py;
  }
  console.error('✗ No Python with mediapipe found. Set up once:\n' +
    '    python3 -m venv .venv-mocap && .venv-mocap/bin/pip install mediapipe opencv-python "numpy<2"\n' +
    '  then re-run, or pass --python <path>. (See docs.)');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (!args.input) { console.error('usage: node tools/video-to-vrma.mjs <url|file> [options]'); process.exit(2); }

fs.mkdirSync(args.outDir, { recursive: true });
const isUrl = /^https?:\/\//.test(args.input);
const framesDir = path.join(args.outDir, 'frames');
const poseJson = path.join(args.outDir, `${args.name}.pose.json`);
const vrmaOut = path.join(args.outDir, `${args.name}.vrma`);
const previewOut = path.join(args.outDir, `${args.name}.mp4`);

console.log(`=== video-to-vrma ===\ninput: ${args.input}${isUrl ? ' (URL)' : ' (local file)'}\nout:   ${args.outDir}`);
if (isUrl) console.log('⚠ LICENSING: outputs are derived from a remote video — keep local, do not redistribute.');

// 1) obtain the video
let source = args.input;
if (isUrl) {
  source = path.join(args.outDir, 'source.mp4');
  run('yt-dlp', ['-f', "bv*[height<=720]+ba/b[height<=720]/b", '--no-playlist', '--merge-output-format', 'mp4', '-o', source.replace('.mp4', '.%(ext)s'), args.input]);
  if (!fs.existsSync(source)) { const alt = fs.readdirSync(args.outDir).find((f) => f.startsWith('source.')); if (alt) source = path.join(args.outDir, alt); }
} else if (!fs.existsSync(source)) { console.error('✗ input file not found: ' + source); process.exit(2); }

// 2) extract frames
fs.rmSync(framesDir, { recursive: true, force: true }); fs.mkdirSync(framesDir, { recursive: true });
run('ffmpeg', ['-i', source, '-vf', `fps=${args.fps}`, '-q:v', '3', path.join(framesDir, '%05d.png'), '-loglevel', 'error']);
const nFrames = fs.readdirSync(framesDir).filter((f) => f.endsWith('.png')).length;
console.log(`frames: ${nFrames}`);

// 3) pose estimation (MediaPipe)
const py = findPython(args.python);
const poseOut = run(py, [path.join(TOOLS, 'extract_pose.py'), framesDir, poseJson], { capture: true });
const poseInfo = JSON.parse((poseOut.trim().split('\n').pop()) || '{}');
console.log(`pose: ${poseInfo.detected}/${poseInfo.frames} frames detected`);

// 4) retarget → .vrma
const len = args.len > 0 ? args.len : (poseInfo.frames - args.start);
const engineScript = args.engine === 'simple' ? 'make-vrma-from-pose.mjs' : 'make-vrma-kalidokit.mjs';
console.log(`retarget engine: ${args.engine} (${engineScript})`);
const vrmaOutLog = run('node', [path.join(TOOLS, engineScript), poseJson, vrmaOut, '--start', String(args.start), '--len', String(len), ...args.retarget], { capture: true });
process.stdout.write(vrmaOutLog);

// 5) preview
let preview = null;
if (args.preview) {
  const pv = run('node', [path.join(TOOLS, 'render-vrma-preview.mjs'), '--vrma', vrmaOut, '--vrm', args.vrm, '--out', previewOut, ...(args.contactSheet ? ['--contact-sheet'] : [])], { capture: true });
  process.stdout.write(pv);
  try { const i = pv.indexOf('{'), j = pv.lastIndexOf('}'); if (i >= 0 && j > i) preview = JSON.parse(pv.slice(i, j + 1)); } catch {}
}

if (!args.keepFrames) fs.rmSync(framesDir, { recursive: true, force: true });

console.log('\n=== DONE ===');
console.log(JSON.stringify({
  input: args.input, vrma: vrmaOut, vrmaBytes: fs.existsSync(vrmaOut) ? fs.statSync(vrmaOut).size : 0,
  preview: preview ? { mp4: preview.mp4, gif: preview.gif, contactSheet: preview.contactSheet, animated: preview.animated, frames: preview.frames } : 'skipped',
  poseDetected: `${poseInfo.detected}/${poseInfo.frames}`,
  licensing: isUrl ? 'LOCAL ONLY — derived from remote video' : 'check your input video license',
}, null, 2));
