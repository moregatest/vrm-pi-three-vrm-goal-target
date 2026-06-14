import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { MotionController } from './motion/MotionController';
import { ClipRegistry } from './motion/clips';

const API_BASE: string =
  ((import.meta as any).env && (import.meta as any).env.VITE_API_BASE) ||
  'http://127.0.0.1:8970';
const DEFAULT_AVATAR = '/avatars/user-avatar.vrm';

const inTauri = !!((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);

// base state (rendering/transport); motion metrics are merged in from the controller
const state: any = {
  webglOK: false, vrmLoaded: false, renderFrames: 0,
  sseConnected: false, currentAvatar: '', mode: inTauri ? 'standalone' : 'agent',
};
(window as any).__VRM_STATE__ = state;

const stateEl = document.getElementById('vrm-state') as HTMLDivElement;
const hud = document.getElementById('hud') as HTMLDivElement;

// ---------- renderer ----------
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
state.webglOK = typeof WebGL2RenderingContext !== 'undefined' && renderer.getContext() instanceof WebGL2RenderingContext;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14233a);
const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.set(0, 1.25, 2.4);
scene.add(new THREE.AmbientLight(0xffffff, 1.4));
scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.2));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(1.5, 2.5, 2.0);
scene.add(key);

// ---------- motion control layer (all the "alive" behavior lives here) ----------
const clipRegistry = new ClipRegistry();
const motion = new MotionController(camera, !inTauri, clipRegistry);

// ---------- VRM load / runtime swap ----------
let currentVrm: any = null;
const clock = new THREE.Clock();
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
function loadVrm(nameOrUrl: string): void {
  const url = avatarUrl(nameOrUrl);
  loader.load(url, (gltf: any) => {
    const vrm = gltf.userData.vrm;
    try { VRMUtils.removeUnnecessaryVertices(gltf.scene); } catch {}
    try { (VRMUtils as any).combineSkeletons?.(gltf.scene); } catch {}
    disposeCurrentVrm();
    vrm.scene.rotation.y = ((vrm.meta as any)?.metaVersion === '0') ? Math.PI : 0; // VRM0 faces -Z
    currentVrm = vrm;
    scene.add(vrm.scene);
    frameAvatar(vrm);
    motion.setVrm(vrm);
    state.vrmLoaded = true;
    state.currentAvatar = url;
    syncDom();
    console.log('[vrm] loaded:', url, vrm?.meta?.name ?? '');
  }, undefined, (err: any) => {
    console.error('[vrm] load error:', url, err);
    // graceful fallback (e.g. a fresh clone without the user-provided default)
    if (!url.endsWith('/avatars/default.vrm')) { console.warn('[vrm] falling back to default.vrm'); loadVrm('/avatars/default.vrm'); }
  });
}
function frameAvatar(vrm: any): void {
  vrm.scene.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const size = new THREE.Vector3(); box.getSize(size);
  // clamp height so odd bounding boxes (accessories, wide T-pose) don't break framing
  const h = (Number.isFinite(size.y) && size.y > 0.2 && size.y < 5) ? size.y : 1.5;
  // aim at the head bone — robust across models, unlike a raw bounding box
  const aim = new THREE.Vector3();
  const head = vrm.humanoid?.getRawBoneNode?.('head') ?? vrm.humanoid?.getNormalizedBoneNode?.('head');
  if (head) { head.getWorldPosition(aim); aim.y -= 0.05; }
  else { const c = new THREE.Vector3(); box.getCenter(c); aim.set(c.x, box.min.y + h * 0.86, c.z); }
  const dist = h * 0.62 + 0.55;
  camera.position.set(aim.x, aim.y + 0.02, aim.z + dist);
  camera.near = 0.05; camera.far = Math.max(20, dist * 12);
  camera.lookAt(aim);
  camera.updateProjectionMatrix();
}

// ---------- DOM state (for the HUD + Playwright proofs) ----------
function syncDom(): void {
  Object.assign(state, motion.getState());
  stateEl.dataset.vrmLoaded = String(state.vrmLoaded);
  stateEl.dataset.renderFrames = String(state.renderFrames);
  stateEl.dataset.lastExpression = state.lastExpression ?? '';
  stateEl.dataset.lastMotion = state.lastMotion ?? '';
  stateEl.dataset.lastSayText = state.lastSayText ?? '';
  stateEl.dataset.currentAvatar = state.currentAvatar;
  stateEl.dataset.mode = state.mode;
  stateEl.dataset.blinkCount = String(state.blinkCount ?? 0);
  stateEl.dataset.realVrmaPlayed = (state.realVrmaPlayed ?? []).join(',');
  stateEl.dataset.proceduralActive = (state.proceduralActive ?? []).join(',');
  stateEl.dataset.lastClipSource = state.lastClipSource ?? '';
  hud.textContent =
    `[${state.mode}] vrmLoaded=${state.vrmLoaded} frames=${state.renderFrames} webgl=${state.webglOK} sse=${state.sseConnected}\n` +
    `expr=${state.lastExpression || '-'} motion=${state.lastMotion || '-'} action=${state.actionName || '-'}(${(state.actionWeight ?? 0).toFixed(2)})\n` +
    `blink#${state.blinkCount ?? 0} mouth=${(state.mouthValue ?? 0).toFixed(2)} affect(v=${(state.valence ?? 0).toFixed(2)},a=${(state.arousal ?? 0).toFixed(2)})\n` +
    `vrma loaded=${(state.realVrmaLoaded ?? []).length} played=${(state.realVrmaPlayed ?? []).length} src=${state.lastClipSource || '-'} proc=${(state.proceduralActive ?? []).length}\n` +
    `say=${state.lastSayText || '-'}\navatar=${state.currentAvatar || '-'}`;
}

// ---------- render loop ----------
function animate(): void {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const now = performance.now();
  motion.update(dt, now);          // idle life, expressions, gaze, mouth, actions
  if (currentVrm) currentVrm.update(dt);
  renderer.render(scene, camera);
  state.renderFrames++;
  if (state.renderFrames % 4 === 0) syncDom();
}
animate();
syncDom();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- transports ----------
function handleEvent(ev: any): void {
  if (!ev || typeof ev !== 'object') return;
  if (ev.type === 'load') { if (ev.url || ev.name) loadVrm(ev.url || ev.name); return; }
  motion.handleEvent(ev);
  syncDom();
}

function populateDropdown(names: string[], onSelect: (name: string) => void): void {
  if (!names || !names.length) return;
  let sel = document.getElementById('avatar-select') as HTMLSelectElement | null;
  if (!sel) {
    sel = document.createElement('select');
    sel.id = 'avatar-select';
    sel.style.cssText = 'position:fixed;right:8px;top:8px;z-index:10;font:12px ui-monospace,monospace;background:#1c2b44;color:#cfe;border:1px solid #456;padding:2px;';
    document.body.appendChild(sel);
    sel.addEventListener('change', () => onSelect(sel!.value));
  }
  sel.innerHTML = '';
  for (const n of names) {
    const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o);
  }
}

function connectSSE(): void {
  const es = new EventSource(`${API_BASE}/vrm/events`);
  es.onopen = () => { state.sseConnected = true; syncDom(); console.log('[sse] open'); };
  es.onerror = () => { state.sseConnected = false; syncDom(); };
  es.onmessage = (e) => { let ev: any; try { ev = JSON.parse(e.data); } catch { return; } (window as any).__VRM_LAST_EVENT__ = ev; handleEvent(ev); };
}
async function setupBrowserDropdown(): Promise<void> {
  try {
    const r = await fetch(`${API_BASE}/vrm/avatars`); if (!r.ok) return;
    populateDropdown(await r.json(), (name) => loadVrm(name));
  } catch { /* API not running */ }
}
async function setupTauri(): Promise<boolean> {
  if (!inTauri) return false;
  try {
    const [{ listen }, { invoke }] = await Promise.all([import('@tauri-apps/api/event'), import('@tauri-apps/api/core')]);
    await listen('vrm-event', (e: any) => handleEvent(e.payload));
    populateDropdown(await invoke('list_avatars'), (name) => invoke('load_avatar', { name }));
  } catch (err) { console.warn('[tauri] setup failed', err); }
  return true;
}

// ---------- boot ----------
async function boot(): Promise<void> {
  // load the VRMA/procedural clip manifest (graceful: procedural-only if absent)
  try {
    const manifest = await fetch('/vrma/clips.json').then((r) => (r.ok ? r.json() : null));
    if (manifest) { clipRegistry.load(manifest); console.log('[clips] loaded', manifest.clips?.length, 'clips'); }
  } catch { /* no manifest → procedural only */ }
  const initial = new URLSearchParams(location.search).get('vrm');
  loadVrm(initial || DEFAULT_AVATAR);
  if (!(await setupTauri())) { connectSSE(); setupBrowserDropdown(); }
}
boot();
