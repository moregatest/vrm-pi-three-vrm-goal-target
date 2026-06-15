// make-vrma-from-pose.mjs — REAL video → VRMA, with TUNABLE retarget flags so an AI
// can observe the rendered result (gif / contact sheet) and adjust to optimum.
// Reads a MediaPipe pose dump (tools/extract_pose.py) and retargets per-frame 3D
// world landmarks to VRM humanoid bone rotations → valid VRMC_vrm_animation .vrma.
//
// Retarget = shortest-arc quaternion from each bone's T-pose rest direction to the
// observed limb direction (forearm/shin bend taken relative to the parent so it
// isn't double-counted). Upper body + spine/head always; legs optional. Light EMA.
//
// Usage: node tools/make-vrma-from-pose.mjs <pose.json> <out.vrma> [flags]
//   --start N --len N      segment of the pose sequence (default 0 .. all)
//   --smooth A             EMA on direction vectors, 0..1 (default 0.4; higher = smoother)
//   --flip-x --flip-y --flip-z   flip a MediaPipe→character axis sign (default y,z flipped)
//   --mirror               swap left/right landmarks (fix mirrored input)
//   --damp-head F          0..1 head rotation strength (default 0.4)
//   --damp-spine F         0..1 spine/chest rotation strength (default 0.7)
//   --legs                 also retarget upper/lower legs
//   --hips                 apply hips yaw from the hip line (default: hips kept still)
import fs from 'node:fs';

function parse(argv) {
  const a = { pose: argv[0], out: argv[1], start: 0, len: 0, smooth: 0.4, sx: 1, sy: -1, sz: -1, mirror: false, dampHead: 0.4, dampSpine: 0.7, legs: false, hips: false, fps: 30 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--start') a.start = Number(argv[++i]);
    else if (k === '--len') a.len = Number(argv[++i]);
    else if (k === '--smooth') a.smooth = Number(argv[++i]);
    else if (k === '--flip-x') a.sx *= -1;
    else if (k === '--flip-y') a.sy *= -1;
    else if (k === '--flip-z') a.sz *= -1;
    else if (k === '--mirror') a.mirror = true;
    else if (k === '--damp-head') a.dampHead = Number(argv[++i]);
    else if (k === '--damp-spine') a.dampSpine = Number(argv[++i]);
    else if (k === '--legs') a.legs = true;
    else if (k === '--hips') a.hips = true;
    else if (!a.pose) a.pose = k; else if (!a.out) a.out = k;
  }
  if (!a.pose || !a.out) { console.error('usage: node tools/make-vrma-from-pose.mjs <pose.json> <out.vrma> [flags]'); process.exit(2); }
  return a;
}
const A = parse(process.argv.slice(2));

// skeleton (T-pose rest); parent by name so legs can be added conditionally
const BASE = [
  ['Hips', 'hips', null, [0, 1.0, 0]],
  ['Spine', 'spine', 'hips', [0, 0.12, 0]],
  ['Chest', 'chest', 'spine', [0, 0.13, 0]],
  ['Neck', 'neck', 'chest', [0, 0.16, 0]],
  ['Head', 'head', 'neck', [0, 0.08, 0]],
  ['LeftUpperArm', 'leftUpperArm', 'chest', [0.12, 0.06, 0]],
  ['LeftLowerArm', 'leftLowerArm', 'leftUpperArm', [0.22, 0, 0]],
  ['RightUpperArm', 'rightUpperArm', 'chest', [-0.12, 0.06, 0]],
  ['RightLowerArm', 'rightLowerArm', 'rightUpperArm', [-0.22, 0, 0]],
];
const LEGS = [
  ['LeftUpperLeg', 'leftUpperLeg', 'hips', [0.09, -0.06, 0]],
  ['LeftLowerLeg', 'leftLowerLeg', 'leftUpperLeg', [0, -0.40, 0]],
  ['RightUpperLeg', 'rightUpperLeg', 'hips', [-0.09, -0.06, 0]],
  ['RightLowerLeg', 'rightLowerLeg', 'rightUpperLeg', [0, -0.40, 0]],
];
const SKEL = A.legs ? [...BASE, ...LEGS] : BASE;

// vec / quat helpers
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const nrm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const ema = (p, c, a) => p ? nrm([p[0] * (1 - a) + c[0] * a, p[1] * (1 - a) + c[1] * a, p[2] * (1 - a) + c[2] * a]) : c;
function qFromUnit(a, b) {
  let w = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + 1, x, y, z;
  if (w < 1e-6) { w = 0; if (Math.abs(a[0]) > Math.abs(a[2])) { x = -a[1]; y = a[0]; z = 0; } else { x = 0; y = -a[2]; z = a[1]; } }
  else { x = a[1] * b[2] - a[2] * b[1]; y = a[2] * b[0] - a[0] * b[2]; z = a[0] * b[1] - a[1] * b[0]; }
  const l = Math.hypot(x, y, z, w) || 1; return [x / l, y / l, z / l, w / l];
}
const damp = (q, f) => { const r = [q[0] * f, q[1] * f, q[2] * f, q[3] * f + (1 - f)]; const l = Math.hypot(...r) || 1; return r.map((v) => v / l); };

const { landmarks } = JSON.parse(fs.readFileSync(A.pose, 'utf8'));
const startLen = A.len > 0 ? A.len : landmarks.length - A.start;
const seg = landmarks.slice(A.start, A.start + startLen).filter((f) => f && f.some((p) => p[3] > 0));
const nFrames = seg.length;
if (nFrames < 5) { console.error('not enough detected frames in segment'); process.exit(1); }

// MediaPipe landmark index → (optionally mirrored)
const MIR = { 11: 12, 12: 11, 13: 14, 14: 13, 15: 16, 16: 15, 23: 24, 24: 23, 25: 26, 26: 25, 27: 28, 28: 27 };
const li = (i) => (A.mirror ? MIR[i] ?? i : i);
const Yp = [0, 1, 0], Yn = [0, -1, 0], Xp = [1, 0, 0], Xn = [-1, 0, 0];

const tracks = SKEL.map(() => new Float32Array(nFrames * 4));
const sm = {};
seg.forEach((lm, fi) => {
  const P = (i) => { const p = lm[li(i)]; return [A.sx * p[0], A.sy * p[1], A.sz * p[2]]; };
  const lsh = P(11), rsh = P(12), lel = P(13), rel = P(14), lwr = P(15), rwr = P(16), nose = P(0);
  const lhip = P(23), rhip = P(24);
  const shoulderC = mid(lsh, rsh), hipC = mid(lhip, rhip);
  const d = (k, v) => (sm[k] = ema(sm[k], nrm(v), A.smooth));
  const spineDir = d('spine', sub(shoulderC, hipC));
  const headDir = d('head', sub(nose, shoulderC));
  const lUp = d('lUp', sub(lel, lsh)), lLo = d('lLo', sub(lwr, lel));
  const rUp = d('rUp', sub(rel, rsh)), rLo = d('rLo', sub(rwr, rel));
  const q = {
    hips: A.hips ? (() => { const hd = nrm([(lhip[0] - rhip[0]), 0, (lhip[2] - rhip[2])]); return qFromUnit(Xp, hd); })() : [0, 0, 0, 1],
    spine: damp(qFromUnit(Yp, spineDir), A.dampSpine),
    chest: [0, 0, 0, 1],
    neck: [0, 0, 0, 1],
    head: damp(qFromUnit(Yp, headDir), A.dampHead),
    leftUpperArm: qFromUnit(Xp, lUp),
    leftLowerArm: qFromUnit(lUp, lLo),
    rightUpperArm: qFromUnit(Xn, rUp),
    rightLowerArm: qFromUnit(rUp, rLo),
  };
  if (A.legs) {
    const lkn = P(25), rkn = P(26), lank = P(27), rank = P(28);
    const lTh = d('lTh', sub(lkn, lhip)), lSh = d('lSh', sub(lank, lkn));
    const rTh = d('rTh', sub(rkn, rhip)), rSh = d('rSh', sub(rank, rkn));
    q.leftUpperLeg = qFromUnit(Yn, lTh); q.leftLowerLeg = qFromUnit(lTh, lSh);
    q.rightUpperLeg = qFromUnit(Yn, rTh); q.rightLowerLeg = qFromUnit(rTh, rSh);
  }
  SKEL.forEach(([, bone], bi) => tracks[bi].set(q[bone] || [0, 0, 0, 1], fi * 4));
});

// pack GLB
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
const nodes = SKEL.map(([name, , , t]) => {
  const kids = SKEL.map((s, j) => (s[2] === name ? j : -1)).filter((j) => j >= 0);
  const n = { name, translation: t, rotation: [0, 0, 0, 1] }; if (kids.length) n.children = kids; return n;
});
const humanBones = {}; SKEL.forEach(([, bone], i) => { humanBones[bone] = { node: i }; });
const gltf = { asset: { version: '2.0', generator: 'make-vrma-from-pose.mjs' }, extensionsUsed: ['VRMC_vrm_animation'], scene: 0, scenes: [{ nodes: [0] }], nodes, animations: [{ name: 'DanceFromVideo', channels, samplers }], accessors, bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.byteLength }], buffers: [{ byteLength: bin.byteLength }], extensions: { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones } } } };
const pad4 = (b, fill) => { const r = b.length % 4; return r ? Buffer.concat([b, Buffer.alloc(4 - r, fill)]) : b; };
const jsonBuf = pad4(Buffer.from(JSON.stringify(gltf), 'utf8'), 0x20), binBuf = pad4(bin, 0x00);
const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(binBuf.length, 0); bh.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(A.out, Buffer.concat([h, jh, jsonBuf, bh, binBuf]));
console.log(JSON.stringify({ out: A.out, bytes: fs.statSync(A.out).size, frames: nFrames, bones: SKEL.length, flags: { start: A.start, len: startLen, smooth: A.smooth, flip: [A.sx, A.sy, A.sz], mirror: A.mirror, dampHead: A.dampHead, dampSpine: A.dampSpine, legs: A.legs, hips: A.hips } }));
