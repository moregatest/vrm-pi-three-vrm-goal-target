// make-vrma-hybrid.mjs — the engine that actually tracks THIS kind of footage.
// BODY: simple geometric retarget (shortest-arc from rest dir to observed limb dir) —
//   self-consistent with our hand-built rig, so arm/leg POSITIONS + facing match the
//   source (Kalidokit's body rotations assume a VRM-normalized bone-axis convention our
//   rig doesn't replicate → arms shot up; see git history).
// FINGERS: Kalidokit.Hand (curl-based, works fine through retarget).
// → correct dance + articulated fingers. Output: valid VRMC_vrm_animation .vrma.
//
// Usage: node tools/make-vrma-hybrid.mjs <pose.json> <out.vrma> [flags]
//   --start N --len N   pose segment       --smooth A   EMA 0..1 (def 0.4)
//   --flip-x/-y/-z      flip a MP axis      --mirror     swap L/R
//   --damp-head F --damp-spine F           --hips       hips yaw   --no-legs   --no-fingers
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const K = require('kalidokit/dist/kalidokit.umd.js');

function parse(argv) {
  const a = { pose: argv[0], out: argv[1], start: 0, len: 0, smooth: 0.4, sx: 1, sy: -1, sz: -1, mirror: false, dampHead: 0.4, dampSpine: 0.7, legs: true, hips: false, fingers: true, fps: 30 };
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
    else if (k === '--hips') a.hips = true;
    else if (k === '--no-legs') a.legs = false;
    else if (k === '--no-fingers') a.fingers = false;
    else if (!a.pose) a.pose = k; else if (!a.out) a.out = k;
  }
  if (!a.pose || !a.out) { console.error('usage: node tools/make-vrma-hybrid.mjs <pose.json> <out.vrma> [flags]'); process.exit(2); }
  return a;
}
const A = parse(process.argv.slice(2));

const data = JSON.parse(fs.readFileSync(A.pose, 'utf8'));
const W = data.landmarks, HD = data.hands || null;
const useFingers = A.fingers && HD;

const cap = (s) => s[0].toUpperCase() + s.slice(1);
function fingerBones(side) {
  const S = side === 'left' ? 1 : -1, hand = side + 'Hand', o = [];
  o.push([cap(side) + 'ThumbMetacarpal', side + 'ThumbMetacarpal', hand, [S * 0.018, -0.01, 0.02]]);
  o.push([cap(side) + 'ThumbProximal', side + 'ThumbProximal', side + 'ThumbMetacarpal', [S * 0.015, 0, 0.012]]);
  o.push([cap(side) + 'ThumbDistal', side + 'ThumbDistal', side + 'ThumbProximal', [S * 0.012, 0, 0.012]]);
  for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
    o.push([cap(side) + f + 'Proximal', side + f + 'Proximal', hand, [S * 0.04, 0, 0]]);
    o.push([cap(side) + f + 'Intermediate', side + f + 'Intermediate', side + f + 'Proximal', [S * 0.025, 0, 0]]);
    o.push([cap(side) + f + 'Distal', side + f + 'Distal', side + f + 'Intermediate', [S * 0.018, 0, 0]]);
  }
  return o;
}
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
  ...(useFingers ? [...fingerBones('left'), ...fingerBones('right')] : []),
];

// helpers
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
function eq(e) { if (!e) return [0, 0, 0, 1]; const x = e.x || 0, y = e.y || 0, z = e.z || 0; const c1 = Math.cos(x / 2), s1 = Math.sin(x / 2), c2 = Math.cos(y / 2), s2 = Math.sin(y / 2), c3 = Math.cos(z / 2), s3 = Math.sin(z / 2); return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3]; }
function nlerp(a, b, t) { let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; const s = d < 0 ? -1 : 1; const r = [a[0] + (b[0] * s - a[0]) * t, a[1] + (b[1] * s - a[1]) * t, a[2] + (b[2] * s - a[2]) * t, a[3] + (b[3] * s - a[3]) * t]; const l = Math.hypot(...r) || 1; return r.map((v) => v / l); }

const MIR = { 11: 12, 12: 11, 13: 14, 14: 13, 15: 16, 16: 15, 23: 24, 24: 23, 25: 26, 26: 25, 27: 28, 28: 27 };
const li = (i) => (A.mirror ? MIR[i] ?? i : i);
const Yp = [0, 1, 0], Yn = [0, -1, 0], Xp = [1, 0, 0], Xn = [-1, 0, 0];

const startLen = A.len > 0 ? A.len : W.length - A.start;
const idxs = [];
for (let i = A.start; i < Math.min(A.start + startLen, W.length); i++) if (W[i] && W[i].some((p) => p[3] > 0)) idxs.push(i);
const nFrames = idxs.length;
if (nFrames < 5) { console.error('not enough detected frames'); process.exit(1); }

const tracks = SKEL.map(() => new Float32Array(nFrames * 4));
const sm = {}, prevF = {};
let handFrames = 0;
idxs.forEach((oi, fi) => {
  const lm = W[oi];
  const P = (i) => { const p = lm[li(i)]; return [A.sx * p[0], A.sy * p[1], A.sz * p[2]]; };
  const lsh = P(11), rsh = P(12), lel = P(13), rel = P(14), lwr = P(15), rwr = P(16), nose = P(0), lhip = P(23), rhip = P(24);
  const shoulderC = mid(lsh, rsh), hipC = mid(lhip, rhip);
  const d = (k, v) => (sm[k] = ema(sm[k], nrm(v), A.smooth));
  const q = {
    hips: A.hips ? qFromUnit(Xp, nrm([lhip[0] - rhip[0], 0, lhip[2] - rhip[2]])) : [0, 0, 0, 1],
    spine: damp(qFromUnit(Yp, d('spine', sub(shoulderC, hipC))), A.dampSpine),
    chest: [0, 0, 0, 1], neck: [0, 0, 0, 1],
    head: damp(qFromUnit(Yp, d('head', sub(nose, shoulderC))), A.dampHead),
    leftUpperArm: qFromUnit(Xp, d('lUp', sub(lel, lsh))), leftLowerArm: qFromUnit(d('lUp', sub(lel, lsh)), d('lLo', sub(lwr, lel))),
    rightUpperArm: qFromUnit(Xn, d('rUp', sub(rel, rsh))), rightLowerArm: qFromUnit(d('rUp', sub(rel, rsh)), d('rLo', sub(rwr, rel))),
    leftHand: [0, 0, 0, 1], rightHand: [0, 0, 0, 1],
  };
  if (A.legs) {
    const lkn = P(25), rkn = P(26), lank = P(27), rank = P(28);
    q.leftUpperLeg = qFromUnit(Yn, d('lTh', sub(lkn, lhip))); q.leftLowerLeg = qFromUnit(d('lTh', sub(lkn, lhip)), d('lSh', sub(lank, lkn)));
    q.rightUpperLeg = qFromUnit(Yn, d('rTh', sub(rkn, rhip))); q.rightLowerLeg = qFromUnit(d('rTh', sub(rkn, rhip)), d('rSh', sub(rank, rkn)));
  }
  if (useFingers) {
    const fh = HD[oi] || {}; let any = false;
    for (const side of ['left', 'right']) {
      const src = A.mirror ? (side === 'left' ? 'right' : 'left') : side;
      const hlm = fh[src];
      if (hlm && hlm.length === 21) {
        let hr; try { hr = K.Hand.solve(hlm.map((p) => ({ x: p[0], y: p[1], z: p[2] })), side === 'left' ? 'Left' : 'Right'); } catch { hr = null; }
        if (hr) {
          const Pf = side === 'left' ? 'Left' : 'Right';
          q[side + 'ThumbMetacarpal'] = eq(hr[Pf + 'ThumbProximal']); q[side + 'ThumbProximal'] = eq(hr[Pf + 'ThumbIntermediate']); q[side + 'ThumbDistal'] = eq(hr[Pf + 'ThumbDistal']);
          for (const f of ['Index', 'Middle', 'Ring', 'Little']) { q[side + f + 'Proximal'] = eq(hr[Pf + f + 'Proximal']); q[side + f + 'Intermediate'] = eq(hr[Pf + f + 'Intermediate']); q[side + f + 'Distal'] = eq(hr[Pf + f + 'Distal']); }
          any = true;
        }
      }
    }
    if (any) handFrames++;
  }
  SKEL.forEach(([, bone], bi) => {
    let v = q[bone] || prevF[bone] || [0, 0, 0, 1];
    if (/Thumb|Index|Middle|Ring|Little/.test(bone) && prevF[bone] && A.smooth > 0) v = nlerp(prevF[bone], v, 1 - A.smooth); // smooth fingers (body already smoothed via dirs)
    prevF[bone] = v;
    tracks[bi].set(v, fi * 4);
  });
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
const nodes = SKEL.map(([name, , , t]) => { const kids = SKEL.map((s, j) => (s[2] === name ? j : -1)).filter((j) => j >= 0); const n = { name, translation: t, rotation: [0, 0, 0, 1] }; if (kids.length) n.children = kids; return n; });
const humanBones = {}; SKEL.forEach(([, bone], i) => { humanBones[bone] = { node: i }; });
const gltf = { asset: { version: '2.0', generator: 'make-vrma-hybrid.mjs' }, extensionsUsed: ['VRMC_vrm_animation'], scene: 0, scenes: [{ nodes: [0] }], nodes, animations: [{ name: 'DanceHybrid', channels, samplers }], accessors, bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.byteLength }], buffers: [{ byteLength: bin.byteLength }], extensions: { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones } } } };
const pad4 = (b, fill) => { const r = b.length % 4; return r ? Buffer.concat([b, Buffer.alloc(4 - r, fill)]) : b; };
const jsonBuf = pad4(Buffer.from(JSON.stringify(gltf), 'utf8'), 0x20), binBuf = pad4(bin, 0x00);
const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(binBuf.length, 0); bh.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(A.out, Buffer.concat([h, jh, jsonBuf, bh, binBuf]));
console.log(JSON.stringify({ engine: 'hybrid', out: A.out, bytes: fs.statSync(A.out).size, frames: nFrames, bones: SKEL.length, handFrames, flags: { start: A.start, len: startLen, smooth: A.smooth, flip: [A.sx, A.sy, A.sz], mirror: A.mirror, legs: A.legs, hips: A.hips, fingers: !!useFingers } }));
