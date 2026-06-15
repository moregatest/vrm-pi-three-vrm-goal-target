// make-vrma-from-pose.mjs — REAL video → VRMA. Reads a MediaPipe pose dump
// (per-frame 3D world landmarks, see tools/extract_pose.py) and retargets it to
// VRM humanoid bone rotations, then writes a valid VRMC_vrm_animation .vrma using
// the same GLB writer as make-vrma.mjs. This closes the loop:
//   video → ffmpeg frames → MediaPipe pose.json → (this) → .vrma → our runtime.
//
// Retarget = shortest-arc quaternion from each bone's T-pose rest direction to the
// observed limb direction (forearm bend is taken relative to the upper arm so it
// isn't double-counted). Upper body + spine/head only; light EMA smoothing.
// Simplified (no twist/fingers/foot IK, blind coord convention) — a PoC of the
// front-end, not broadcast mocap. See docs/dance-video-to-vrma-plan.md §8.
//
// Usage: node tools/make-vrma-from-pose.mjs <pose.json> <out.vrma> [startFrame] [len]
import fs from 'node:fs';

const POSE = process.argv[2] || '/tmp/dance-poc/pose.json';
const OUT = process.argv[3] || '/tmp/dance-poc/dance_real.vrma';
const START = Number(process.argv[4] ?? 180);
const LEN = Number(process.argv[5] ?? 240);
const FPS = 30;

const SKEL = [
  ['Hips', 'hips', -1, [0, 1.0, 0]],
  ['Spine', 'spine', 0, [0, 0.12, 0]],
  ['Chest', 'chest', 1, [0, 0.13, 0]],
  ['Neck', 'neck', 2, [0, 0.16, 0]],
  ['Head', 'head', 3, [0, 0.08, 0]],
  ['LeftUpperArm', 'leftUpperArm', 2, [0.12, 0.06, 0]],
  ['LeftLowerArm', 'leftLowerArm', 5, [0.22, 0, 0]],
  ['RightUpperArm', 'rightUpperArm', 2, [-0.12, 0.06, 0]],
  ['RightLowerArm', 'rightLowerArm', 7, [-0.22, 0, 0]],
];

// --- vec / quat helpers ---
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const nrm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const ema = (prev, cur, a) => prev ? nrm([prev[0] * (1 - a) + cur[0] * a, prev[1] * (1 - a) + cur[1] * a, prev[2] * (1 - a) + cur[2] * a]) : cur;
function qFromUnit(a, b) { // shortest-arc rotation a→b (a,b unit)
  let w = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + 1, x, y, z;
  if (w < 1e-6) { w = 0; if (Math.abs(a[0]) > Math.abs(a[2])) { x = -a[1]; y = a[0]; z = 0; } else { x = 0; y = -a[2]; z = a[1]; } }
  else { x = a[1] * b[2] - a[2] * b[1]; y = a[2] * b[0] - a[0] * b[2]; z = a[0] * b[1] - a[1] * b[0]; }
  const l = Math.hypot(x, y, z, w) || 1; return [x / l, y / l, z / l, w / l];
}
const qDampToIdentity = (q, f) => { // nlerp identity→q by f
  const r = [q[0] * f, q[1] * f, q[2] * f, q[3] * f + (1 - f)]; const l = Math.hypot(...r) || 1; return r.map((v) => v / l);
};

const { landmarks } = JSON.parse(fs.readFileSync(POSE, 'utf8'));
const seg = landmarks.slice(START, START + LEN).filter((f) => f && f.some((p) => p[3] > 0));
const nFrames = seg.length;
if (nFrames < 5) { console.error('not enough detected frames in segment'); process.exit(1); }

// MediaPipe world → character frame (Y up, +Z toward camera): [x, -y, -z]
const P = (lm, i) => [lm[i][0], -lm[i][1], -lm[i][2]];
const Yp = [0, 1, 0], Xp = [1, 0, 0], Xn = [-1, 0, 0];

const tracks = SKEL.map(() => new Float32Array(nFrames * 4));
const sm = {}; // smoothing state per direction
seg.forEach((lm, fi) => {
  const lsh = P(lm, 11), rsh = P(lm, 12), lel = P(lm, 13), rel = P(lm, 14),
    lwr = P(lm, 15), rwr = P(lm, 16), lhip = P(lm, 23), rhip = P(lm, 24), nose = P(lm, 0);
  const shoulderC = mid(lsh, rsh), hipC = mid(lhip, rhip);
  const d = (k, v) => (sm[k] = ema(sm[k], nrm(v), 0.4));
  const spineDir = d('spine', sub(shoulderC, hipC));
  const headDir = d('head', sub(nose, shoulderC));
  const lUp = d('lUp', sub(lel, lsh)), lLo = d('lLo', sub(lwr, lel));
  const rUp = d('rUp', sub(rel, rsh)), rLo = d('rLo', sub(rwr, rel));
  const q = {
    hips: [0, 0, 0, 1],
    spine: qDampToIdentity(qFromUnit(Yp, spineDir), 0.7),
    chest: [0, 0, 0, 1],
    neck: [0, 0, 0, 1],
    head: qDampToIdentity(qFromUnit(Yp, headDir), 0.4),
    leftUpperArm: qFromUnit(Xp, lUp),
    leftLowerArm: qFromUnit(lUp, lLo),    // elbow bend relative to upper arm
    rightUpperArm: qFromUnit(Xn, rUp),
    rightLowerArm: qFromUnit(rUp, rLo),
  };
  SKEL.forEach(([, bone], bi) => tracks[bi].set(q[bone], fi * 4));
});

// --- pack GLB (same as make-vrma.mjs) ---
const times = new Float32Array(nFrames);
for (let i = 0; i < nFrames; i++) times[i] = i / FPS;
const parts = [times, ...tracks];
let total = 0; for (const p of parts) total += p.byteLength;
const bin = Buffer.alloc(total);
let off = 0; const offsets = [];
for (const p of parts) { offsets.push(off); Buffer.from(p.buffer, p.byteOffset, p.byteLength).copy(bin, off); off += p.byteLength; }

const accessors = [{ bufferView: 0, byteOffset: offsets[0], componentType: 5126, count: nFrames, type: 'SCALAR', min: [0], max: [times[nFrames - 1]] }];
const channels = [], samplers = [];
SKEL.forEach((s, bi) => { accessors.push({ bufferView: 0, byteOffset: offsets[bi + 1], componentType: 5126, count: nFrames, type: 'VEC4' }); samplers.push({ input: 0, interpolation: 'LINEAR', output: bi + 1 }); channels.push({ sampler: bi, target: { node: bi, path: 'rotation' } }); });
const nodes = SKEL.map(([name, , parent, t], i) => { const children = SKEL.map((_, j) => j).filter((j) => SKEL[j][2] === i); const n = { name, translation: t, rotation: [0, 0, 0, 1] }; if (children.length) n.children = children; return n; });
const humanBones = {}; SKEL.forEach(([, bone], i) => { humanBones[bone] = { node: i }; });
const gltf = { asset: { version: '2.0', generator: 'make-vrma-from-pose.mjs' }, extensionsUsed: ['VRMC_vrm_animation'], scene: 0, scenes: [{ nodes: [0] }], nodes, animations: [{ name: 'DanceFromVideo', channels, samplers }], accessors, bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.byteLength }], buffers: [{ byteLength: bin.byteLength }], extensions: { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones } } } };
const pad4 = (b, fill) => { const r = b.length % 4; return r ? Buffer.concat([b, Buffer.alloc(4 - r, fill)]) : b; };
const jsonBuf = pad4(Buffer.from(JSON.stringify(gltf), 'utf8'), 0x20), binBuf = pad4(bin, 0x00);
const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(binBuf.length, 0); bh.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(OUT, Buffer.concat([h, jh, jsonBuf, bh, binBuf]));
console.log(`wrote ${OUT} (${fs.statSync(OUT).size} bytes, ${nFrames} frames @ ${FPS}fps from real video, ${SKEL.length} bones)`);
