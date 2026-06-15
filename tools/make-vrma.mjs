// make-vrma.mjs — programmatically write a real VRMA (.vrma) from joint-angle
// keyframes. This is the "→ VRMA" back-end of the dance-video pipeline: any pose
// source (MediaPipe+Kalidokit, WHAM/GVHMR, BVH, hand-authored) reduces to per-bone
// local rotations over time, which this turns into a valid glTF + VRMC_vrm_animation
// (spec: https://github.com/vrm-c/vrm-specification/tree/master/specification/VRMC_vrm_animation-1.0).
//
// Usage: node tools/make-vrma.mjs [outFile] [seconds]
// Default: writes a short synthetic upper-body "dance" to public/vrma/generated_demo.vrma
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.argv[2] || path.join(ROOT, 'public/vrma/generated_demo.vrma');
const SECONDS = Number(process.argv[3] || 3);
const FPS = 30;

// --- minimal humanoid skeleton (VRM T-pose rest); node index = array position ---
// each: [name, humanBone, parentIndex, restTranslation]
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

// euler(radians, XYZ) -> quaternion [x,y,z,w]
function eulerToQuat(x, y, z) {
  const cx = Math.cos(x / 2), sx = Math.sin(x / 2);
  const cy = Math.cos(y / 2), sy = Math.sin(y / 2);
  const cz = Math.cos(z / 2), sz = Math.sin(z / 2);
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}

// synthetic "dance" → local rotation (euler) for a bone at time t (sec).
// Swap this function for real pose data (MediaPipe/Kalidokit/WHAM) keyframes.
function poseEuler(bone, t) {
  const w = (hz) => Math.sin(t * Math.PI * 2 * hz);
  switch (bone) {
    case 'hips': return [0, w(0.6) * 0.18, 0];
    case 'spine': return [0, 0, w(0.6) * 0.06];
    case 'chest': return [0, 0, Math.sin(t * Math.PI * 2 * 0.6 + 0.5) * 0.05];
    case 'neck': return [w(1.0) * 0.05, w(0.7) * 0.05, 0];
    case 'head': return [w(1.0) * 0.10, w(0.7) * 0.12, 0];
    case 'rightUpperArm': return [0, 0, -0.6 + w(1.2) * 0.6];     // raised + wave
    case 'rightLowerArm': return [0, 0, 0.2 + Math.sin(t * Math.PI * 2 * 1.5) * 0.5];
    case 'leftUpperArm': return [0, 0, 0.6 + Math.sin(t * Math.PI * 2 * 1.2 + Math.PI) * 0.6];
    case 'leftLowerArm': return [0, 0, -0.2 + Math.sin(t * Math.PI * 2 * 1.5 + Math.PI) * 0.5];
    default: return [0, 0, 0];
  }
}

const nFrames = Math.round(SECONDS * FPS) + 1;
const times = new Float32Array(nFrames);
for (let i = 0; i < nFrames; i++) times[i] = i / FPS;

// rotation track per bone (VEC4 * nFrames)
const tracks = SKEL.map(([, bone]) => {
  const arr = new Float32Array(nFrames * 4);
  for (let i = 0; i < nFrames; i++) {
    const [x, y, z] = poseEuler(bone, times[i]);
    const q = eulerToQuat(x, y, z);
    arr.set(q, i * 4);
  }
  return arr;
});

// --- pack one binary blob: [times][track0][track1]... ---
const parts = [times, ...tracks];
let total = 0; for (const p of parts) total += p.byteLength;
const bin = Buffer.alloc(total);
let off = 0; const offsets = [];
for (const p of parts) { offsets.push(off); Buffer.from(p.buffer, p.byteOffset, p.byteLength).copy(bin, off); off += p.byteLength; }

// --- glTF JSON ---
const accessors = [
  { bufferView: 0, byteOffset: offsets[0], componentType: 5126, count: nFrames, type: 'SCALAR', min: [0], max: [times[nFrames - 1]] },
];
const channels = [], samplers = [];
SKEL.forEach((s, bi) => {
  const accIdx = accessors.length;
  accessors.push({ bufferView: 0, byteOffset: offsets[bi + 1], componentType: 5126, count: nFrames, type: 'VEC4' });
  samplers.push({ input: 0, interpolation: 'LINEAR', output: accIdx });
  channels.push({ sampler: bi, target: { node: bi, path: 'rotation' } });
});

const nodes = SKEL.map(([name, , parent, t], i) => {
  const children = SKEL.map((_, j) => j).filter((j) => SKEL[j][2] === i);
  const n = { name, translation: t, rotation: [0, 0, 0, 1] };
  if (children.length) n.children = children;
  return n;
});

const humanBones = {};
SKEL.forEach(([, bone], i) => { humanBones[bone] = { node: i }; });

const gltf = {
  asset: { version: '2.0', generator: 'make-vrma.mjs (vrm-pi-three-vrm-goal-target)' },
  extensionsUsed: ['VRMC_vrm_animation'],
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes,
  animations: [{ name: 'GeneratedDance', channels, samplers }],
  accessors,
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.byteLength }],
  buffers: [{ byteLength: bin.byteLength }],
  extensions: { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones } } },
};

// --- assemble GLB ---
const pad4 = (b, fill) => { const r = b.length % 4; return r ? Buffer.concat([b, Buffer.alloc(4 - r, fill)]) : b; };
const jsonBuf = pad4(Buffer.from(JSON.stringify(gltf), 'utf8'), 0x20);
const binBuf = pad4(bin, 0x00);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);                 // 'glTF'
header.writeUInt32LE(2, 4);                          // version
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(jsonBuf.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(binBuf.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);   // 'BIN\0'

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([header, jsonHeader, jsonBuf, binHeader, binBuf]));
console.log(`wrote ${OUT} (${fs.statSync(OUT).size} bytes, ${nFrames} frames @ ${FPS}fps, ${SKEL.length} bones)`);
