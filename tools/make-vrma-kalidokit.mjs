// make-vrma-kalidokit.mjs — higher-quality video → VRMA using Kalidokit's
// purpose-built MediaPipe→VRM solver (proper kinematics + limb twist + legs +
// wrist orientation) instead of the naive shortest-arc retarget. Reads a pose dump
// with BOTH world-3D and image-2D landmarks (tools/extract_pose.py) and writes a
// valid VRMC_vrm_animation .vrma (same GLB writer as the other engines).
//
// Usage: node tools/make-vrma-kalidokit.mjs <pose.json> <out.vrma> [flags]
//   --start N --len N   pose segment (default 0 .. all)
//   --smooth A          EMA on output quats 0..1 (default 0.3; higher = smoother)
//   --mirror            un-mirror (swap L/R + flip yaw/roll) for third-person video
//   --flat-hips         zero hips yaw (keep facing forward; fixes noisy spins)
//   --no-legs           skip legs
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const K = require('kalidokit/dist/kalidokit.umd.js');   // ESM build has dir-imports; UMD works in Node

function parse(argv) {
  const a = { pose: argv[0], out: argv[1], start: 0, len: 0, smooth: 0.3, mirror: false, flatHips: false, faceFlip: false, legs: true, fps: 30 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--start') a.start = Number(argv[++i]);
    else if (k === '--len') a.len = Number(argv[++i]);
    else if (k === '--smooth') a.smooth = Number(argv[++i]);
    else if (k === '--mirror') a.mirror = true;
    else if (k === '--flat-hips') a.flatHips = true;
    else if (k === '--face-flip') a.faceFlip = true;          // rotate whole avatar 180° about Y (fix back-facing)
    else if (k === '--no-legs') a.legs = false;
    else if (!a.pose) a.pose = k; else if (!a.out) a.out = k;
  }
  if (!a.pose || !a.out) { console.error('usage: node tools/make-vrma-kalidokit.mjs <pose.json> <out.vrma> [flags]'); process.exit(2); }
  return a;
}
const A = parse(process.argv.slice(2));

const SKEL = [
  ['Hips', 'hips', null, [0, 1.0, 0]],
  ['Spine', 'spine', 'hips', [0, 0.12, 0]],
  ['Chest', 'chest', 'spine', [0, 0.13, 0]],
  ['Neck', 'neck', 'chest', [0, 0.16, 0]],
  ['Head', 'head', 'neck', [0, 0.08, 0]],
  ['LeftUpperArm', 'leftUpperArm', 'chest', [0.12, 0.06, 0]],
  ['LeftLowerArm', 'leftLowerArm', 'leftUpperArm', [0.22, 0, 0]],
  ['LeftHand', 'leftHand', 'leftLowerArm', [0.22, 0, 0]],
  ['RightUpperArm', 'rightUpperArm', 'chest', [-0.12, 0.06, 0]],
  ['RightLowerArm', 'rightLowerArm', 'rightUpperArm', [-0.22, 0, 0]],
  ['RightHand', 'rightHand', 'rightLowerArm', [-0.22, 0, 0]],
  ...(A.legs ? [
    ['LeftUpperLeg', 'leftUpperLeg', 'hips', [0.09, -0.06, 0]],
    ['LeftLowerLeg', 'leftLowerLeg', 'leftUpperLeg', [0, -0.40, 0]],
    ['RightUpperLeg', 'rightUpperLeg', 'hips', [-0.09, -0.06, 0]],
    ['RightLowerLeg', 'rightLowerLeg', 'rightUpperLeg', [0, -0.40, 0]],
  ] : []),
];

// three.js Euler(XYZ) → quaternion [x,y,z,w]
function eq(e) {
  if (!e) return [0, 0, 0, 1];
  const x = e.x || 0, y = e.y || 0, z = e.z || 0;
  const c1 = Math.cos(x / 2), s1 = Math.sin(x / 2), c2 = Math.cos(y / 2), s2 = Math.sin(y / 2), c3 = Math.cos(z / 2), s3 = Math.sin(z / 2);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
}
function nlerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; const s = d < 0 ? -1 : 1;
  const r = [a[0] + (b[0] * s - a[0]) * t, a[1] + (b[1] * s - a[1]) * t, a[2] + (b[2] * s - a[2]) * t, a[3] + (b[3] * s - a[3]) * t];
  const l = Math.hypot(...r) || 1; return r.map((v) => v / l);
}
const mir = (e) => (e ? { x: e.x, y: -e.y, z: -e.z } : e);   // mirror a rotation across the sagittal plane

const data = JSON.parse(fs.readFileSync(A.pose, 'utf8'));
const w3 = data.landmarks, i2 = data.landmarks2d || data.landmarks;
const len = A.len > 0 ? A.len : w3.length - A.start;
const idxs = [];
for (let i = A.start; i < Math.min(A.start + len, w3.length); i++) if (w3[i] && w3[i].some((p) => p[3] > 0)) idxs.push(i);
const nFrames = idxs.length;
if (nFrames < 5) { console.error('not enough detected frames'); process.exit(1); }

const toLM = (arr) => arr.map((p) => ({ x: p[0], y: p[1], z: p[2], visibility: p[3] }));
const tracks = SKEL.map(() => new Float32Array(nFrames * 4));
const prev = {};
idxs.forEach((fi, k) => {
  let rig;
  try { rig = K.Pose.solve(toLM(w3[fi]), toLM(i2[fi]), { runtime: 'mediapipe', enableLegs: A.legs }); } catch { rig = null; }
  // map Kalidokit rig → VRM humanoid bone euler
  let m = rig ? {
    hips: A.flatHips ? { x: rig.Hips.rotation.x, y: 0, z: rig.Hips.rotation.z } : rig.Hips.rotation,
    spine: rig.Spine,
    leftUpperArm: rig.LeftUpperArm, leftLowerArm: rig.LeftLowerArm, leftHand: rig.LeftHand,
    rightUpperArm: rig.RightUpperArm, rightLowerArm: rig.RightLowerArm, rightHand: rig.RightHand,
    leftUpperLeg: rig.LeftUpperLeg, leftLowerLeg: rig.LeftLowerLeg,
    rightUpperLeg: rig.RightUpperLeg, rightLowerLeg: rig.RightLowerLeg,
  } : null;
  if (m && A.mirror) m = {
    hips: mir(m.hips), spine: mir(m.spine),
    leftUpperArm: mir(m.rightUpperArm), leftLowerArm: mir(m.rightLowerArm), leftHand: mir(m.rightHand),
    rightUpperArm: mir(m.leftUpperArm), rightLowerArm: mir(m.leftLowerArm), rightHand: mir(m.leftHand),
    leftUpperLeg: mir(m.rightUpperLeg), leftLowerLeg: mir(m.rightLowerLeg),
    rightUpperLeg: mir(m.leftUpperLeg), rightLowerLeg: mir(m.leftLowerLeg),
  };
  SKEL.forEach(([, bone], bi) => {
    let q = m && m[bone] ? eq(m[bone]) : (prev[bone] || [0, 0, 0, 1]);
    if (bone === 'hips' && A.faceFlip && m && m.hips) q = [q[2], q[3], -q[0], -q[1]]; // (0,1,0,0)*q = Y180·q
    if (prev[bone] && A.smooth > 0) q = nlerp(prev[bone], q, 1 - A.smooth);
    prev[bone] = q;
    tracks[bi].set(q, k * 4);
  });
});

// pack GLB (shared with the other engines)
const times = new Float32Array(nFrames);
for (let i = 0; i < nFrames; i++) times[i] = i / A.fps;
const parts = [times, ...tracks];
let total = 0; for (const p of parts) total += p.byteLength;
const bin = Buffer.alloc(total);
let off = 0; const offsets = [];
for (const p of parts) { offsets.push(off); Buffer.from(p.buffer, p.byteOffset, p.byteLength).copy(bin, off); off += p.byteLength; }
const accessors = [{ bufferView: 0, byteOffset: offsets[0], componentType: 5126, count: nFrames, type: 'SCALAR', min: [0], max: [times[nFrames - 1]] }];
const channels = [], samplers = [];
SKEL.forEach((s, bi) => { accessors.push({ bufferView: 0, byteOffset: offsets[bi + 1], componentType: 5126, count: nFrames, type: 'VEC4' }); samplers.push({ input: 0, interpolation: 'LINEAR', output: bi + 1 }); channels.push({ sampler: bi, target: { node: bi, path: 'rotation' } }); });
const nodes = SKEL.map(([name, , , t]) => { const kids = SKEL.map((s, j) => (s[2] === name ? j : -1)).filter((j) => j >= 0); const n = { name, translation: t, rotation: [0, 0, 0, 1] }; if (kids.length) n.children = kids; return n; });
const humanBones = {}; SKEL.forEach(([, bone], i) => { humanBones[bone] = { node: i }; });
const gltf = { asset: { version: '2.0', generator: 'make-vrma-kalidokit.mjs' }, extensionsUsed: ['VRMC_vrm_animation'], scene: 0, scenes: [{ nodes: [0] }], nodes, animations: [{ name: 'DanceKalidokit', channels, samplers }], accessors, bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.byteLength }], buffers: [{ byteLength: bin.byteLength }], extensions: { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones } } } };
const pad4 = (b, fill) => { const r = b.length % 4; return r ? Buffer.concat([b, Buffer.alloc(4 - r, fill)]) : b; };
const jsonBuf = pad4(Buffer.from(JSON.stringify(gltf), 'utf8'), 0x20), binBuf = pad4(bin, 0x00);
const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(binBuf.length, 0); bh.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(A.out, Buffer.concat([h, jh, jsonBuf, bh, binBuf]));
console.log(JSON.stringify({ engine: 'kalidokit', out: A.out, bytes: fs.statSync(A.out).size, frames: nFrames, bones: SKEL.length, flags: { start: A.start, len, smooth: A.smooth, mirror: A.mirror, flatHips: A.flatHips, legs: A.legs } }));
