// preview.ts — a minimal, deterministic three-vrm + three-vrm-animation viewer
// used to RENDER a preview of a generated .vrma applied to a VRM. It loads
// ?vrm=&vrma= , plays the clip, and exposes window.__preview.seek(t) so a headless
// browser can step the animation frame-by-frame for a reproducible MP4/GIF.
// (Lighting/camera/VRM0-facing mirror src/main.ts so the preview matches the app.)
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

const q = new URLSearchParams(location.search);
const VRM_URL = q.get('vrm') || '/avatars/default.vrm';
const VRMA_URL = q.get('vrma') || '/vrma/generated_demo.vrma';
const BG = q.get('bg') || '#14233a';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);
const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.set(0, 1.25, 2.4);
scene.add(new THREE.AmbientLight(0xffffff, 1.4));
scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.2));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(1.5, 2.5, 2.0);
scene.add(key);

const previewState: any = { ready: false, error: null, durationSec: 0, vrm: VRM_URL, vrma: VRMA_URL };
(window as any).__preview = previewState;

function frameAvatar(vrm: any): void {
  vrm.scene.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const size = new THREE.Vector3(); box.getSize(size);
  const h = (Number.isFinite(size.y) && size.y > 0.2 && size.y < 5) ? size.y : 1.4;
  // frame the whole upper body + head with margin (dance uses arms/torso, not just face)
  const aimY = box.min.y + h * 0.56;
  const dist = h * 1.15 + 0.4;
  camera.position.set(0, box.min.y + h * 0.64, dist);
  camera.near = 0.05; camera.far = Math.max(20, dist * 12);
  camera.lookAt(0, aimY, 0);
  camera.updateProjectionMatrix();
}

let mixer: THREE.AnimationMixer | null = null;
let vrm: any = null;

async function main(): Promise<void> {
  const lv = new GLTFLoader();
  lv.register((p: any) => new VRMLoaderPlugin(p));
  const gv = await lv.loadAsync(VRM_URL);
  vrm = gv.userData.vrm;
  try { VRMUtils.removeUnnecessaryVertices(gv.scene); } catch {}
  vrm.scene.rotation.y = ((vrm.meta as any)?.metaVersion === '0') ? Math.PI : 0; // VRM0 faces -Z
  scene.add(vrm.scene);
  frameAvatar(vrm);

  const la = new GLTFLoader();
  la.register((p: any) => new VRMAnimationLoaderPlugin(p));
  const ga = await la.loadAsync(VRMA_URL);
  const anim = ga.userData.vrmAnimations?.[0];
  if (!anim) throw new Error('no VRM animation in ' + VRMA_URL);
  const clip = createVRMAnimationClip(anim, vrm);
  mixer = new THREE.AnimationMixer(vrm.scene);
  mixer.clipAction(clip).play();
  previewState.durationSec = clip.duration;

  seek(0);
  previewState.ready = true;
}

function seek(t: number): void {
  if (mixer) { mixer.setTime(t); }
  if (vrm) { vrm.update(0); }
  renderer.render(scene, camera);
}
previewState.seek = seek;

main().catch((e) => { previewState.error = String(e?.message || e); console.error('[preview]', e); });
