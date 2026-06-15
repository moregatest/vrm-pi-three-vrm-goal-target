// smpl-to-vrma.mjs — convert per-frame SMPL pose params (from the Colab GPU step,
// colab/dance_to_smpl.ipynb → ROMP/WHAM/GVHMR) into a VRMC_vrm_animation .vrma.
// SMPL gives FULL per-joint rotations (axis-angle), so unlike the MediaPipe pipeline
// this carries limb TWIST. Same GLB writer as the other engines.
//
// Input JSON (what the Colab emits):
//   { "fps": 30, "frames": [ { "thetas": [72 floats], "trans": [x,y,z] }, ... ] }
//   thetas = SMPL 24 joints × 3 axis-angle (joint 0 = global/root orient).
//
// Usage: node tools/smpl-to-vrma.mjs <smpl.json> <out.vrma> [flags]
//   --start N --len N   frame segment        --smooth A   EMA on quats (def 0.25)
//   --flip-x/-y/-z      flip a root axis      --face-flip  rotate avatar 180° about Y
//   --no-legs                                   (coord convention may need 1 tuning pass — use the contact-sheet loop)
import fs from 'node:fs';

function parse(argv) {
  const a = { in: argv[0], out: argv[1], start: 0, len: 0, smooth: 0.25, sx: 1, sy: 1, sz: 1, faceFlip: false, legs: true, fps: 30 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--start') a.start = Number(argv[++i]);
    else if (k === '--len') a.len = Number(argv[++i]);
    else if (k === '--smooth') a.smooth = Number(argv[++i]);
    else if (k === '--flip-x') a.sx *= -1;
    else if (k === '--flip-y') a.sy *= -1;
    else if (k === '--flip-z') a.sz *= -1;
    else if (k === '--face-flip') a.faceFlip = true;
    else if (k === '--no-legs') a.legs = false;
    else if (!a.in) a.in = k; else if (!a.out) a.out = k;
  }
  if (!a.in || !a.out) { console.error('usage: node tools/smpl-to-vrma.mjs <smpl.json> <out.vrma> [flags]'); process.exit(2); }
  return a;
}
const A = parse(process.argv.slice(2));

// SMPL 24-joint index → VRM humanoid bone (null = no VRM bone)
const SMPL2VRM = ['hips', 'leftUpperLeg', 'rightUpperLeg', 'spine', 'leftLowerLeg', 'rightLowerLeg',
  'chest', 'leftFoot', 'rightFoot', 'upperChest', null, null, 'neck', 'leftShoulder', 'rightShoulder',
  'head', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand', null, null];

// VRM skeleton (rest T-pose); parent by name
let SKEL = [
  ['Hips', 'hips', null, [0, 1.0, 0]],
  ['Spine', 'spine', 'hips', [0, 0.10, 0]],
  ['Chest', 'chest', 'spine', [0, 0.10, 0]],
  ['UpperChest', 'upperChest', 'chest', [0, 0.10, 0]],
  ['Neck', 'neck', 'upperChest', [0, 0.12, 0]],
  ['Head', 'head', 'neck', [0, 0.08, 0]],
  ['LeftShoulder', 'leftShoulder', 'upperChest', [0.05, 0.08, 0]],
  ['LeftUpperArm', 'leftUpperArm', 'leftShoulder', [0.10, 0, 0]],
  ['LeftLowerArm', 'leftLowerArm', 'leftUpperArm', [0.22, 0, 0]],
  ['LeftHand', 'leftHand', 'leftLowerArm', [0.22, 0, 0]],
  ['RightShoulder', 'rightShoulder', 'upperChest', [-0.05, 0.08, 0]],
  ['RightUpperArm', 'rightUpperArm', 'rightShoulder', [-0.10, 0, 0]],
  ['RightLowerArm', 'rightLowerArm', 'rightUpperArm', [-0.22, 0, 0]],
  ['RightHand', 'rightHand', 'rightLowerArm', [-0.22, 0, 0]],
  ...(A.legs ? [
    ['LeftUpperLeg', 'leftUpperLeg', 'hips', [0.09, -0.06, 0]],
    ['LeftLowerLeg', 'leftLowerLeg', 'leftUpperLeg', [0, -0.40, 0]],
    ['LeftFoot', 'leftFoot', 'leftLowerLeg', [0, -0.40, 0]],
    ['RightUpperLeg', 'rightUpperLeg', 'hips', [-0.09, -0.06, 0]],
    ['RightLowerLeg', 'rightLowerLeg', 'rightUpperLeg', [0, -0.40, 0]],
    ['RightFoot', 'rightFoot', 'rightLowerLeg', [0, -0.40, 0]],
  ] : []),
];
const boneSet = new Set(SKEL.map((s) => s[1]));

// axis-angle (3) → quaternion [x,y,z,w]
function aaToQuat(x, y, z) {
  const ang = Math.hypot(x, y, z);
  if (ang < 1e-8) return [0, 0, 0, 1];
  const s = Math.sin(ang / 2) / ang;
  return [x * s, y * s, z * s, Math.cos(ang / 2)];
}
function nlerp(a, b, t) { let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; const sg = d < 0 ? -1 : 1; const r = [a[0] + (b[0] * sg - a[0]) * t, a[1] + (b[1] * sg - a[1]) * t, a[2] + (b[2] * sg - a[2]) * t, a[3] + (b[3] * sg - a[3]) * t]; const l = Math.hypot(...r) || 1; return r.map((v) => v / l); }

const data = JSON.parse(fs.readFileSync(A.in, 'utf8'));
const allFrames = data.frames || [];
const len = A.len > 0 ? A.len : allFrames.length - A.start;
const frames = allFrames.slice(A.start, A.start + len).filter((f) => f && f.thetas && f.thetas.length >= 72);
const nFrames = frames.length;
if (nFrames < 2) { console.error('not enough SMPL frames'); process.exit(1); }
if (A.fps !== (data.fps || 30)) A.fps = data.fps || 30;

const tracks = SKEL.map(() => new Float32Array(nFrames * 4));
const prev = {};
frames.forEach((fr, k) => {
  const q = {};
  for (let j = 0; j < 24; j++) {
    const bone = SMPL2VRM[j];
    if (!bone || !boneSet.has(bone)) continue;
    let ax = fr.thetas[j * 3], ay = fr.thetas[j * 3 + 1], az = fr.thetas[j * 3 + 2];
    if (j === 0) { ax *= A.sx; ay *= A.sy; az *= A.sz; }   // root coord flips
    let quat = aaToQuat(ax, ay, az);
    if (j === 0 && A.faceFlip) quat = [quat[2], quat[3], -quat[0], -quat[1]]; // Y180·q
    q[bone] = quat;
  }
  SKEL.forEach(([, bone], bi) => {
    let v = q[bone] || prev[bone] || [0, 0, 0, 1];
    if (prev[bone] && A.smooth > 0) v = nlerp(prev[bone], v, 1 - A.smooth);
    prev[bone] = v;
    tracks[bi].set(v, k * 4);
  });
});

// pack GLB (shared)
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
const gltf = { asset: { version: '2.0', generator: 'smpl-to-vrma.mjs' }, extensionsUsed: ['VRMC_vrm_animation'], scene: 0, scenes: [{ nodes: [0] }], nodes, animations: [{ name: 'DanceSMPL', channels, samplers }], accessors, bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.byteLength }], buffers: [{ byteLength: bin.byteLength }], extensions: { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones } } } };
const pad4 = (b, fill) => { const r = b.length % 4; return r ? Buffer.concat([b, Buffer.alloc(4 - r, fill)]) : b; };
const jsonBuf = pad4(Buffer.from(JSON.stringify(gltf), 'utf8'), 0x20), binBuf = pad4(bin, 0x00);
const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(binBuf.length, 0); bh.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(A.out, Buffer.concat([h, jh, jsonBuf, bh, binBuf]));
console.log(JSON.stringify({ engine: 'smpl', out: A.out, bytes: fs.statSync(A.out).size, frames: nFrames, bones: SKEL.length, flags: { start: A.start, len, smooth: A.smooth, flip: [A.sx, A.sy, A.sz], faceFlip: A.faceFlip, legs: A.legs } }));
