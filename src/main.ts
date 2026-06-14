import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const API_BASE: string =
  ((import.meta as any).env && (import.meta as any).env.VITE_API_BASE) ||
  'http://127.0.0.1:8970';

type VrmState = {
  webglOK: boolean;
  vrmLoaded: boolean;
  renderFrames: number;
  lastExpression: string;
  lastMotion: string;
  lastSayText: string;
  lastEventType: string;
  sseConnected: boolean;
  currentAvatar: string;
  mode: string; // 'agent' (SSE) or 'standalone' (Tauri)
};

const state: VrmState = {
  webglOK: false,
  vrmLoaded: false,
  renderFrames: 0,
  lastExpression: '',
  lastMotion: '',
  lastSayText: '',
  lastEventType: '',
  sseConnected: false,
  currentAvatar: '',
  mode: 'agent',
};
(window as any).__VRM_STATE__ = state;

const stateEl = document.getElementById('vrm-state') as HTMLDivElement;
const hud = document.getElementById('hud') as HTMLDivElement;

function syncDom(): void {
  stateEl.dataset.vrmLoaded = String(state.vrmLoaded);
  stateEl.dataset.renderFrames = String(state.renderFrames);
  stateEl.dataset.lastExpression = state.lastExpression;
  stateEl.dataset.lastMotion = state.lastMotion;
  stateEl.dataset.lastSayText = state.lastSayText;
  stateEl.dataset.webglOk = String(state.webglOK);
  stateEl.dataset.sseConnected = String(state.sseConnected);
  stateEl.dataset.currentAvatar = state.currentAvatar;
  stateEl.dataset.mode = state.mode;
  hud.textContent =
    `[${state.mode}] vrmLoaded=${state.vrmLoaded} frames=${state.renderFrames} webgl=${state.webglOK} sse=${state.sseConnected}\n` +
    `expr=${state.lastExpression || '-'}  motion=${state.lastMotion || '-'}\n` +
    `say=${state.lastSayText || '-'}\n` +
    `avatar=${state.currentAvatar || '-'}`;
}

// ---------- renderer ----------
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  preserveDrawingBuffer: true, // lets the render proof read pixels back any frame
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const glCtx = renderer.getContext();
state.webglOK =
  typeof WebGL2RenderingContext !== 'undefined' &&
  glCtx instanceof WebGL2RenderingContext;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14233a); // distinctive (non-white/non-black)

const camera = new THREE.PerspectiveCamera(
  35, window.innerWidth / window.innerHeight, 0.05, 100,
);
camera.position.set(0, 1.25, 2.4);

scene.add(new THREE.AmbientLight(0xffffff, 1.4));
scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.2));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(1.5, 2.5, 2.0);
scene.add(key);

// ---------- VRM (load / swap at runtime) ----------
let currentVrm: any = null;
const clock = new THREE.Clock();
const REST_RU_Z = 1.0; // right upper-arm rest rotation
let waving = false;    // 'wave' persists until reset / another motion
let mouthUntil = 0;
let nodUntil = 0;

const loader = new GLTFLoader();
loader.register((parser: any) => new VRMLoaderPlugin(parser));

function avatarUrl(nameOrUrl: string): string {
  if (/^https?:\/\//.test(nameOrUrl) || nameOrUrl.startsWith('/')) return nameOrUrl;
  return `/avatars/${nameOrUrl}${nameOrUrl.endsWith('.vrm') ? '' : '.vrm'}`;
}

function disposeCurrentVrm(): void {
  if (!currentVrm) return;
  try { scene.remove(currentVrm.scene); } catch {}
  try { (VRMUtils as any).deepDispose?.(currentVrm.scene); } catch {}
  currentVrm = null;
}

/** Load (or swap to) a VRM at runtime. */
function loadVrm(nameOrUrl: string): void {
  const url = avatarUrl(nameOrUrl);
  loader.load(
    url,
    (gltf: any) => {
      const vrm = gltf.userData.vrm;
      try { VRMUtils.removeUnnecessaryVertices(gltf.scene); } catch {}
      try { (VRMUtils as any).combineSkeletons?.(gltf.scene); } catch {}
      disposeCurrentVrm();                 // drop the previous avatar
      // The VRM 1.0 sample faces +Z (toward the camera); VRM 0.x faces -Z, so
      // flip those 180° to present the front.
      vrm.scene.rotation.y = ((vrm.meta as any)?.metaVersion === '0') ? Math.PI : 0;
      currentVrm = vrm;
      scene.add(vrm.scene);
      waving = false; mouthUntil = 0; nodUntil = 0; // reset transient action state
      relaxArms(vrm);
      frameAvatar(vrm);
      state.vrmLoaded = true;
      state.currentAvatar = url;
      syncDom();
      console.log('[vrm] loaded:', url, vrm?.meta?.name ?? '');
    },
    undefined,
    (err: any) => { console.error('[vrm] load error:', url, err); },
  );
}

function frameAvatar(vrm: any): void {
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const height = size.y || 1.5;
  const target = new THREE.Vector3(center.x, box.min.y + height * 0.86, center.z);
  const dist = height * 0.95;
  camera.position.set(center.x, target.y, center.z + dist);
  camera.far = Math.max(20, dist * 12);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
}

function relaxArms(vrm: any): void {
  const h = vrm?.humanoid; if (!h) return;
  const lu = h.getNormalizedBoneNode('leftUpperArm');
  const ru = h.getNormalizedBoneNode('rightUpperArm');
  if (lu) lu.rotation.z = -REST_RU_Z;
  if (ru) ru.rotation.z = REST_RU_Z;
}

// ---------- semantic action handlers ----------
const EMOTION_MAP: Record<string, string> = {
  happy: 'happy', joy: 'happy', smile: 'happy', glad: 'happy',
  angry: 'angry', mad: 'angry',
  sad: 'sad', sorrow: 'sad', unhappy: 'sad',
  relaxed: 'relaxed', calm: 'relaxed',
  surprised: 'surprised', surprise: 'surprised', shocked: 'surprised',
  neutral: 'neutral',
};
const PRESETS = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral'];

function setExpression(emotion: string): void {
  state.lastExpression = emotion;
  state.lastEventType = 'expression';
  const em = currentVrm?.expressionManager;
  if (em) {
    const preset = EMOTION_MAP[(emotion || '').toLowerCase()] || 'neutral';
    for (const p of PRESETS) { try { em.setValue(p, p === preset ? 1.0 : 0.0); } catch {} }
  }
  syncDom();
}

function startMotion(motion: string): void {
  state.lastMotion = motion;
  state.lastEventType = 'motion';
  waving = (motion || '').toLowerCase() === 'wave';
  if ((motion || '').toLowerCase() === 'nod') nodUntil = performance.now() + 2500;
  syncDom();
}

function applyMotion(vrm: any, tNow: number): void {
  const h = vrm?.humanoid; if (!h) return;
  const ru = h.getNormalizedBoneNode('rightUpperArm');
  const rl = h.getNormalizedBoneNode('rightLowerArm');
  if (ru) {
    const targetZ = waving ? -1.25 : REST_RU_Z;
    ru.rotation.z += (targetZ - ru.rotation.z) * 0.15;
  }
  if (rl) {
    const wag = waving ? Math.sin(tNow * 0.013) * 0.6 : 0;
    const targetZ = (waving ? -0.2 : 0.15) + wag;
    rl.rotation.z += (targetZ - rl.rotation.z) * 0.3;
  }
  const headBone = h.getNormalizedBoneNode('head');
  if (headBone) {
    const targetX = tNow < nodUntil ? Math.sin(tNow * 0.012) * 0.35 : 0;
    headBone.rotation.x += (targetX - headBone.rotation.x) * 0.2;
  }
}

function say(text: string): void {
  state.lastSayText = text;
  state.lastEventType = 'say';
  mouthUntil = performance.now() + Math.min(8000, 1200 + (text?.length || 0) * 55);
  syncDom();
}

function applyMouth(vrm: any, tNow: number): void {
  const em = vrm?.expressionManager; if (!em) return;
  const open = tNow < mouthUntil ? 0.4 + 0.4 * Math.abs(Math.sin(tNow * 0.018)) : 0;
  try { em.setValue('aa', open); } catch {}
}

function resetAll(): void {
  state.lastExpression = '';
  state.lastMotion = '';
  state.lastSayText = '';
  state.lastEventType = 'reset';
  waving = false; mouthUntil = 0; nodUntil = 0;
  const em = currentVrm?.expressionManager;
  if (em) for (const p of [...PRESETS, 'aa']) { try { em.setValue(p, 0); } catch {} }
  syncDom();
}

/** Single entry point for every transport (SSE + Tauri). */
function handleEvent(ev: any): void {
  if (!ev || typeof ev !== 'object') return;
  switch (ev.type) {
    case 'expression': setExpression(ev.emotion); break;
    case 'motion': startMotion(ev.motion); break;
    case 'say': say(ev.text); break;
    case 'reset': resetAll(); break;
    case 'load': if (ev.url || ev.name) loadVrm(ev.url || ev.name); break;
    default: break;
  }
}

// ---------- render loop ----------
function animate(): void {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const tNow = performance.now();
  if (currentVrm) {
    applyMotion(currentVrm, tNow);
    applyMouth(currentVrm, tNow);
    currentVrm.update(dt);
  }
  renderer.render(scene, camera);
  state.renderFrames++;
  if (state.renderFrames % 6 === 0) syncDom();
}
animate();
syncDom();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- avatar picker (both modes) ----------
function populateDropdown(names: string[], onSelect: (name: string) => void): void {
  if (!names || !names.length) return;
  let sel = document.getElementById('avatar-select') as HTMLSelectElement | null;
  if (!sel) {
    sel = document.createElement('select');
    sel.id = 'avatar-select';
    sel.style.cssText =
      'position:fixed;right:8px;top:8px;z-index:10;font:12px ui-monospace,monospace;' +
      'background:#1c2b44;color:#cfe;border:1px solid #456;padding:2px;';
    document.body.appendChild(sel);
    sel.addEventListener('change', () => onSelect(sel!.value));
  }
  sel.innerHTML = '';
  for (const n of names) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n;
    sel.appendChild(o);
  }
}

// ---------- transports ----------
function connectSSE(): void {
  const es = new EventSource(`${API_BASE}/vrm/events`);
  es.onopen = () => { state.sseConnected = true; syncDom(); console.log('[sse] open'); };
  es.onerror = () => { state.sseConnected = false; syncDom(); };
  es.onmessage = (e) => {
    let ev: any; try { ev = JSON.parse(e.data); } catch { return; }
    (window as any).__VRM_LAST_EVENT__ = ev;
    handleEvent(ev);
  };
}

async function setupBrowserDropdown(): Promise<void> {
  try {
    const r = await fetch(`${API_BASE}/vrm/avatars`);
    if (!r.ok) return;
    const names: string[] = await r.json();
    populateDropdown(names, (name) => loadVrm(name));
  } catch { /* API not running — dropdown stays hidden */ }
}

async function setupTauri(): Promise<boolean> {
  const w = window as any;
  if (!w.__TAURI_INTERNALS__ && !w.__TAURI__) return false; // not in the Tauri webview
  state.mode = 'standalone';
  syncDom();
  try {
    const [{ listen }, { invoke }] = await Promise.all([
      import('@tauri-apps/api/event'),
      import('@tauri-apps/api/core'),
    ]);
    await listen('vrm-event', (e: any) => handleEvent(e.payload));
    const avatars: string[] = await invoke('list_avatars');
    populateDropdown(avatars, (name) => invoke('load_avatar', { name }));
  } catch (err) { console.warn('[tauri] setup failed', err); }
  return true;
}

// ---------- boot ----------
async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const initial = params.get('vrm');
  loadVrm(initial || '/avatars/default.vrm');

  const inTauri = await setupTauri(); // standalone: Tauri IPC + Rust rules autopilot
  if (!inTauri) {
    connectSSE();                     // agent mode: Node API/SSE (Pi agent, proofs)
    setupBrowserDropdown();
  }
}
boot();
