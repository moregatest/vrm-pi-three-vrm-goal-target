// Proof H — the preview renderer turns a .vrma + VRM into a real, animated video.
// Renders the SYNTHETIC generated_demo.vrma on default.vrm (pixiv MIT) → a committable
// demo (docs/images/preview-demo.{mp4,gif}) and asserts the files are non-empty and
// actually animate (captured frames differ). No copyright (synthetic motion + MIT VRM).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(ROOT, 'docs/images/preview-demo.mp4');
const gif = out.replace(/\.[^.]+$/, '') + '.gif';
fs.mkdirSync(path.dirname(out), { recursive: true });

const r = spawnSync('node', ['tools/render-vrma-preview.mjs',
  '--vrma', '/vrma/generated_demo.vrma', '--vrm', '/avatars/default.vrm',
  '--out', out, '--fps', '20', '--width', '480', '--height', '640', '--gif-width', '320', '--gif-fps', '12'],
  { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

function extractJson(s) { const i = s.indexOf('{'), j = s.lastIndexOf('}'); try { return i >= 0 && j > i ? JSON.parse(s.slice(i, j + 1)) : {}; } catch { return {}; } }
const summary = extractJson(r.stdout || '');

const checks = {
  rendererExit0: r.status === 0,
  summaryOk: summary.ok === true,
  animated: summary.animated === true,
  mp4NonEmpty: (summary.mp4Bytes || 0) > 1000,
  gifNonEmpty: (summary.gifBytes || 0) > 1000,
  enoughFrames: (summary.frames || 0) >= 20,
  filesOnDisk: fs.existsSync(out) && fs.existsSync(gif),
};
const failed = Object.entries(checks).filter(([, v]) => v !== true).map(([k]) => k);
const result = { pass: failed.length === 0, checks, failed, summary, demo: { mp4: out, gif } };
console.log('\n=== PROOF H RESULT ===\n' + JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
