import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import { ACTIONS, MOTION_ALIAS, type ActionDef } from './actions';
import { ClipRegistry, type IntentLike } from './clips';

const PRESETS = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral'] as const;
const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;

const EMOTION_MAP: Record<string, string> = {
  happy: 'happy', joy: 'happy', smile: 'happy', glad: 'happy',
  angry: 'angry', mad: 'angry',
  sad: 'sad', sorrow: 'sad', unhappy: 'sad',
  relaxed: 'relaxed', calm: 'relaxed',
  surprised: 'surprised', surprise: 'surprised', shocked: 'surprised',
  neutral: 'neutral',
};

const REST: Record<string, { x?: number; y?: number; z?: number }> = {
  leftUpperArm: { z: -1.0 }, rightUpperArm: { z: 1.0 },
  leftLowerArm: { z: -0.15 }, rightLowerArm: { z: 0.15 },
};
const CONTROLLED_BONES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'rightShoulder',
  'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm',
];

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const noise = (t: number) =>
  Math.sin(t * 1.1) * 0.5 + Math.sin(t * 2.3 + 1.7) * 0.3 + Math.sin(t * 0.7 + 4.2) * 0.2;

interface ActiveAction {
  def: ActionDef; start: number; intensity: number;
  weight: number; releasing: boolean; releaseStart: number;
}

/**
 * Continuous character control layer + VRMA performance layer.
 * Procedural systems (idle/face/gaze/mouth/actions) keep the avatar alive;
 * a VRMA AnimationMixer plays real signature clips on top (procedural micro
 * stays as an additive overlay while a VRMA clip runs). The agent only emits
 * semantic intents — the ClipRegistry selector chooses vrma-vs-procedural.
 */
export class MotionController {
  private vrm: any = null;
  private bones: Record<string, any> = {};
  private camera: THREE.Camera;
  private isBrowser: boolean;
  private registry: ClipRegistry | null;
  private lookTarget = new THREE.Object3D();

  // affect
  private valence = 0; private arousal = 0;
  private override: { preset: string; until: number; total: number } | null = null;
  private exprCur: Record<string, number> = {};

  // blink
  private blinkVal = 0; private blinkTarget = 0; private nextBlink = 0;
  private blinkCount = 0; private blinkPhase = 0;

  // gaze
  private gazeYaw = 0; private gazePitch = 0;
  private nextGaze = 0; private gTYaw = 0; private gTPitch = 0;
  private mouseYaw = 0; private mousePitch = 0; private mouseUntil = 0;

  // mouth / speech
  private visemeTimeline: { t: number; v: string; open: number }[] = [];
  private speakStart = 0; private speakEnd = 0;
  private mouthCur: Record<string, number> = {};
  private lastViseme = ''; private visemeChanges = 0;

  // procedural action scheduler
  private actions: ActiveAction[] = [];
  private lastAction = '';

  // VRMA mixer layer
  private mixer: THREE.AnimationMixer | null = null;
  private vrmaThreeClips: Record<string, THREE.AnimationClip> = {};
  private vrmaAction: THREE.AnimationAction | null = null;
  private vrmaActive = false;
  private vrmaEndAt = 0;
  private vrmaBlendOutMs = 400;
  private realVrmaLoaded: string[] = [];
  private realVrmaPlayed: string[] = [];
  private lastClipSource = '';
  private clientLog: any[] = [];

  // metrics
  private poseSignature = 0;
  private lastExpression = ''; private lastMotion = ''; private lastSayText = '';

  constructor(camera: THREE.Camera, isBrowser: boolean, registry?: ClipRegistry) {
    this.camera = camera; this.isBrowser = isBrowser; this.registry = registry ?? null;
    if (isBrowser) {
      window.addEventListener('mousemove', (e) => {
        const nx = (e.clientX / window.innerWidth) * 2 - 1;
        const ny = (e.clientY / window.innerHeight) * 2 - 1;
        this.mouseYaw = -nx * 0.5; this.mousePitch = ny * 0.28;
        this.mouseUntil = performance.now() + 2500;
      });
    }
  }

  private log(type: string, data: any = {}): void {
    this.clientLog.push({ ts: Date.now(), type, ...data });
    if (this.clientLog.length > 24) this.clientLog.shift();
  }

  setVrm(vrm: any): void {
    this.vrm = vrm;
    this.bones = {};
    const h = vrm?.humanoid;
    if (h) for (const b of CONTROLLED_BONES) { const n = h.getNormalizedBoneNode(b); if (n) this.bones[b] = n; }
    if (vrm?.lookAt) vrm.lookAt.target = this.lookTarget;
    // reset transient state
    this.actions = []; this.override = null; this.valence = 0; this.arousal = 0;
    this.exprCur = {}; this.mouthCur = {}; this.blinkVal = 0; this.blinkPhase = 0; this.nextBlink = 0;
    this.speakEnd = 0; this.visemeTimeline = [];
    this.lastExpression = ''; this.lastMotion = ''; this.lastSayText = '';
    // (re)build the VRMA mixer for this model
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.vrmaThreeClips = {}; this.vrmaAction = null; this.vrmaActive = false;
    this.realVrmaLoaded = [];
    this.loadVrmaClips(vrm);
  }

  private loadVrmaClips(vrm: any): void {
    if (!this.registry) return;
    const loader = new GLTFLoader();
    loader.register((p: any) => new VRMAnimationLoaderPlugin(p));
    for (const clip of this.registry.vrma()) {
      if (clip.source.kind !== 'vrma') continue;
      const file = clip.source.file;
      loader.load(file, (gltf: any) => {
        const anim = gltf.userData?.vrmAnimations?.[0];
        if (!anim) { this.log('vrma_load_failed', { clipId: clip.id, reason: 'no vrmAnimations' }); return; }
        try {
          this.vrmaThreeClips[clip.id] = createVRMAnimationClip(anim, vrm);
          if (!this.realVrmaLoaded.includes(clip.id)) this.realVrmaLoaded.push(clip.id);
          this.log('vrma_loaded', { clipId: clip.id, file });
          console.log('[vrma] loaded clip', clip.id, file);
        } catch (e) { this.log('vrma_load_failed', { clipId: clip.id, reason: String(e) }); }
      }, undefined, (err: any) => { this.log('vrma_load_failed', { clipId: clip.id, reason: String(err) }); console.warn('[vrma] load error', file, err); });
    }
  }

  handleEvent(ev: any): void {
    if (!ev || typeof ev !== 'object') return;
    switch (ev.type) {
      case 'expression': this.applyExpression(ev.emotion); break;
      case 'motion': this.routeGesture(ev.motion, {}); this.lastMotion = ev.motion || ''; break;
      case 'action': this.routeGesture(ev.name, ev); this.lastMotion = ev.name || ''; break;
      case 'say': this.startSpeech(ev.text || ''); break;
      case 'mood': this.applyMood(ev.mood, ev.strength, ev.decayMs); break;
      case 'reset': this.reset(); break;
      default: break;
    }
  }

  private currentEmotion(): string {
    if (this.valence > 0.25) return 'happy';
    if (this.valence < -0.25) return 'sad';
    if (this.arousal > 0.4) return 'surprised';
    return 'neutral';
  }

  /** Map a gesture/action name → intent → clip (vrma or procedural). */
  private routeGesture(name: string, opts: any): void {
    const g = (name || '').toLowerCase();
    const intent: IntentLike = {
      type: 'gesture', gesture: g, emotion: this.currentEmotion(),
      intensity: typeof opts.intensity === 'number' ? opts.intensity : 0.7,
    };
    const now = performance.now();
    this.log('intent_received', { intent });
    let clip = this.registry?.select(intent, now, (id) => !!this.vrmaThreeClips[id]) ?? null;
    // ensure a name-matching, loaded VRMA wins for this gesture (the clean path,
    // rather than falling through to the "any loaded VRMA" safety net below)
    if (!clip || clip.source.kind !== 'vrma') {
      const m = (this.registry?.vrma() || []).find((c) =>
        this.vrmaThreeClips[c.id] && (c.id.toLowerCase().includes(g) || (c.tags || []).map((t) => t.toLowerCase()).includes(g)));
      if (m) clip = m;
    }

    if (clip && clip.source.kind === 'vrma' && this.vrmaThreeClips[clip.id]) {
      this.log('clip_selected', { clipId: clip.id, source: 'vrma' });
      this.playVrma(clip.id, clip.durationMs, clip.blend?.inMs ?? 200, clip.blend?.outMs ?? 400, opts.intensity);
      this.registry?.markPlayed(clip.id, now);
      return;
    }
    // Fallback: a gesture was requested but no matching VRMA is ready.
    // If ANY real VRMA is loaded, play it for the signature (log fallback);
    // otherwise use a procedural action.
    if ((g === 'wave' || intent.type === 'gesture') && this.realVrmaLoaded.length && this.vrmaThreeClips[this.realVrmaLoaded[0]]) {
      const id = this.realVrmaLoaded[0];
      this.log('clip_fallback', { requested: g, used: id, source: 'vrma' });
      this.playVrma(id, ACTIONS[g]?.durationMs ?? 2000, 200, 400, opts.intensity);
      this.registry?.markPlayed(id, now);
      return;
    }
    const procName = (clip && clip.source.kind === 'procedural' && clip.source.generator) || MOTION_ALIAS[g] || g;
    this.log('clip_selected', { clipId: clip?.id ?? procName, source: 'procedural' });
    this.startAction(procName, opts);
    if (clip) this.registry?.markPlayed(clip.id, now);
    this.lastClipSource = 'procedural';
  }

  private playVrma(clipId: string, durationMs: number, blendInMs: number, blendOutMs: number, intensity?: number): void {
    const clip = this.vrmaThreeClips[clipId];
    if (!clip || !this.mixer) return;
    if (this.vrmaAction) { try { this.vrmaAction.fadeOut(0.2); } catch {} }
    const action = this.mixer.clipAction(clip);
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.timeScale = 1;
    action.setEffectiveWeight(typeof intensity === 'number' ? clamp01(intensity) : 1);
    action.fadeIn(Math.max(0.05, blendInMs / 1000));
    action.play();
    this.vrmaAction = action;
    this.vrmaActive = true;
    this.vrmaBlendOutMs = blendOutMs;
    this.vrmaEndAt = performance.now() + durationMs;
    if (!this.realVrmaPlayed.includes(clipId)) this.realVrmaPlayed.push(clipId);
    this.lastClipSource = 'vrma';
    this.log('clip_started', { clipId, source: 'vrma' });
  }

  private endVrma(): void {
    if (this.vrmaAction) { try { this.vrmaAction.fadeOut(Math.max(0.05, this.vrmaBlendOutMs / 1000)); } catch {} }
    this.vrmaActive = false;
  }

  // ---------- expression / affect ----------
  private applyExpression(emotion: string): void {
    const preset = EMOTION_MAP[(emotion || '').toLowerCase()] || 'neutral';
    this.lastExpression = emotion || '';
    this.override = { preset, until: performance.now() + 6000, total: 6000 };
    if (preset === 'happy') { this.valence += 0.5; this.arousal += 0.2; }
    else if (preset === 'sad') { this.valence -= 0.5; }
    else if (preset === 'angry') { this.valence -= 0.3; this.arousal += 0.5; }
    else if (preset === 'surprised') { this.arousal += 0.6; }
    else if (preset === 'relaxed') { this.arousal -= 0.3; this.valence += 0.2; }
    this.clampAffect();
    this.log('expression_set', { emotion: preset });
  }
  private applyMood(mood: string, strength = 0.6, _d = 12000): void {
    const s = clamp01(strength);
    switch ((mood || '').toLowerCase()) {
      case 'happy': case 'joyful': this.valence += 0.8 * s; this.arousal += 0.3 * s; break;
      case 'curious': this.arousal += 0.5 * s; this.valence += 0.2 * s; break;
      case 'sad': case 'down': this.valence -= 0.7 * s; break;
      case 'angry': this.valence -= 0.4 * s; this.arousal += 0.7 * s; break;
      case 'calm': case 'relaxed': this.arousal -= 0.4 * s; this.valence += 0.3 * s; break;
      case 'sleepy': case 'tired': this.arousal -= 0.6 * s; break;
      case 'surprised': this.arousal += 0.8 * s; break;
      default: break;
    }
    this.clampAffect();
    this.log('mood_set', { mood, strength: s });
  }
  private clampAffect(): void {
    this.valence = Math.max(-1, Math.min(1, this.valence));
    this.arousal = Math.max(-1, Math.min(1, this.arousal));
  }

  private startSpeech(text: string): void {
    this.lastSayText = text;
    this.visemeTimeline = buildVisemes(text);
    const dur = this.visemeTimeline.length ? this.visemeTimeline[this.visemeTimeline.length - 1].t + 300 : 0;
    this.speakStart = performance.now(); this.speakEnd = this.speakStart + dur;
    this.log('say_started', { text });
  }

  // ---------- procedural action scheduler ----------
  private startAction(name: string, opts: any): void {
    const def = ACTIONS[name] || ACTIONS[MOTION_ALIAS[name]];
    if (!def) return;
    const now = performance.now();
    const intensity = typeof opts.intensity === 'number' ? clamp01(opts.intensity) : 1.0;
    const merged: ActionDef = {
      ...def,
      durationMs: opts.durationMs ?? def.durationMs,
      blendInMs: opts.blendInMs ?? def.blendInMs,
      blendOutMs: opts.blendOutMs ?? def.blendOutMs,
    };
    for (const a of this.actions) if (a.def.name === merged.name && !a.releasing) { a.releasing = true; a.releaseStart = now; }
    this.actions.push({ def: merged, start: now, intensity, weight: 0, releasing: false, releaseStart: 0 });
    this.lastAction = merged.name;
  }
  private updateActions(now: number): void {
    for (const a of this.actions) {
      const age = now - a.start;
      if (!a.releasing && !a.def.loop && age >= a.def.durationMs) { a.releasing = true; a.releaseStart = now; }
      if (a.releasing) { const rt = now - a.releaseStart; a.weight = a.intensity * Math.max(0, 1 - rt / Math.max(1, a.def.blendOutMs)); }
      else a.weight = a.intensity * Math.min(1, age / Math.max(1, a.def.blendInMs));
    }
    this.actions = this.actions.filter((a) => !(a.releasing && now - a.releaseStart >= a.def.blendOutMs));
  }

  reset(): void {
    this.actions = []; this.override = null; this.valence = 0; this.arousal = 0;
    this.speakEnd = 0; this.visemeTimeline = [];
    this.lastExpression = ''; this.lastMotion = ''; this.lastSayText = '';
    this.endVrma();
    this.log('reset', {});
  }

  // ---------- per-frame ----------
  update(dt: number, now: number): void {
    if (!this.vrm) return;
    const d = Math.exp(-dt * 0.09); this.valence *= d; this.arousal *= d;
    this.updateActions(now);
    this.updateExpressions(dt, now);
    if (this.vrmaActive && this.mixer) {
      this.mixer.update(dt);          // VRMA drives the body
      this.microOverlay(dt, now);     // additive breathing / gaze keeps it alive
      if (now >= this.vrmaEndAt) this.endVrma();
      // once fully faded, drop back to procedural next frames
      if (!this.vrmaActive && this.vrmaAction && this.vrmaAction.getEffectiveWeight() < 0.02) this.vrmaAction = null;
    } else {
      if (this.mixer) this.mixer.update(dt); // lets a fading-out action finish cleanly
      this.updatePose(dt, now);       // full procedural
    }
  }

  private updateExpressions(dt: number, now: number): void {
    const em = this.vrm?.expressionManager; if (!em) return;
    const tgt: Record<string, number> = { happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0, neutral: 0 };
    tgt.happy = clamp01(Math.max(0, this.valence) * 0.75);
    tgt.sad = clamp01(Math.max(0, -this.valence) * 0.65);
    tgt.surprised = clamp01(Math.max(0, this.arousal - 0.3) * 0.7);
    tgt.relaxed = clamp01(Math.max(0, -this.arousal) * 0.5 + Math.max(0, this.valence) * 0.15);
    if (this.override) {
      const left = this.override.until - now;
      if (left <= 0) this.override = null;
      else tgt[this.override.preset] = Math.max(tgt[this.override.preset] || 0, clamp01(left / this.override.total));
    }
    for (const a of this.actions) if (a.def.expression) {
      const t = (now - a.start) / 1000;
      for (const [k, v] of Object.entries(a.def.expression(t, a.intensity))) if (k in tgt) tgt[k] = Math.max(tgt[k], v * a.weight);
    }
    const aSlow = 1 - Math.exp(-dt * 8);
    for (const p of PRESETS) { this.exprCur[p] = (this.exprCur[p] ?? 0) + (tgt[p] - (this.exprCur[p] ?? 0)) * aSlow; try { em.setValue(p, this.exprCur[p]); } catch {} }
    this.updateBlink(dt, now); try { em.setValue('blink', this.blinkVal); } catch {}
    this.updateMouth(dt, now, em);
  }

  private updateBlink(dt: number, now: number): void {
    if (this.nextBlink === 0) this.nextBlink = now + 1200 + Math.random() * 2500;
    if (this.blinkPhase === 0 && now >= this.nextBlink) { this.blinkPhase = 1; this.blinkTarget = 1; }
    const aFast = 1 - Math.exp(-dt * 32);
    this.blinkVal += (this.blinkTarget - this.blinkVal) * aFast;
    if (this.blinkPhase === 1 && this.blinkVal > 0.9) { this.blinkPhase = 2; this.blinkTarget = 0; }
    if (this.blinkPhase === 2 && this.blinkVal < 0.1) {
      this.blinkPhase = 0; this.blinkCount++;
      const base = Math.random() < 0.18 ? 170 : 1400 + Math.random() * 3400;
      this.nextBlink = now + base * Math.max(0.4, 1 - this.arousal * 0.25);
    }
  }

  private updateMouth(dt: number, now: number, em: any): void {
    const cur: Record<string, number> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    if (now < this.speakEnd && this.visemeTimeline.length) {
      const tms = now - this.speakStart;
      let seg = this.visemeTimeline[0];
      for (const s of this.visemeTimeline) { if (s.t <= tms) seg = s; else break; }
      if (seg.v !== 'close') cur[seg.v] = seg.open;
      if (seg.v !== this.lastViseme) { this.visemeChanges++; this.lastViseme = seg.v; }
    }
    const a = 1 - Math.exp(-dt * 18);
    for (const v of VISEMES) { this.mouthCur[v] = (this.mouthCur[v] ?? 0) + ((cur[v] || 0) - (this.mouthCur[v] ?? 0)) * a; try { em.setValue(v, this.mouthCur[v]); } catch {} }
  }

  private updateGaze(dt: number, now: number): void {
    let ty: number, tp: number;
    if (this.isBrowser && now < this.mouseUntil) { ty = this.mouseYaw; tp = this.mousePitch; }
    else if (now < this.speakEnd) { ty = 0; tp = -0.02; }
    else {
      if (this.nextGaze === 0 || now >= this.nextGaze) {
        this.gTYaw = (Math.random() * 2 - 1) * 0.25; this.gTPitch = (Math.random() * 2 - 1) * 0.12;
        this.nextGaze = now + 2000 + Math.random() * 3000;
      }
      ty = this.gTYaw; tp = this.gTPitch;
    }
    const a = 1 - Math.exp(-dt * 4);
    this.gazeYaw += (ty - this.gazeYaw) * a; this.gazePitch += (tp - this.gazePitch) * a;
    if (this.vrm?.lookAt) this.lookTarget.position.set(Math.sin(this.gazeYaw), 1.35 - this.gazePitch, Math.cos(this.gazeYaw) + 0.5);
  }

  /** Additive micro-motion layered on top of a running VRMA clip. */
  private microOverlay(dt: number, now: number): void {
    const t = now / 1000;
    // keep the body facing the camera even if the VRMA clip authored a different
    // root/hips yaw — the clip still drives arms/head (the actual gesture).
    // The generic sample clip folds the whole torso + dips the head. Keep the
    // body upright & facing the camera so only the ARM (the actual gesture) comes
    // from the VRMA — a clean, readable wave. (Production: drop in a polished
    // wave .vrma and relax these clamps.)
    const clampX = (n: string, lo: number, hi: number) => { const b = this.bones[n]; if (b) b.rotation.x = Math.max(lo, Math.min(hi, b.rotation.x)); };
    const hips = this.bones['hips']; if (hips) { hips.rotation.y = 0; hips.rotation.x = Math.max(-0.06, Math.min(0.06, hips.rotation.x)); hips.rotation.z = 0; }
    clampX('spine', -0.08, 0.12); clampX('chest', -0.08, 0.12);
    clampX('neck', -0.12, 0.12); clampX('head', -0.16, 0.14);
    const breath = Math.sin(t * 1.5) * 0.012;
    const spine = this.bones['spine']; const chest = this.bones['chest']; const head = this.bones['head'];
    if (spine) spine.rotation.x += breath * 0.6;
    if (chest) chest.rotation.x += breath;
    this.updateGaze(dt, now);
    if (head) { head.rotation.x += this.gazePitch * 0.4 + noise(t * 0.6) * 0.008; head.rotation.y += this.gazeYaw * 0.4; }
    this.poseSignature = (head?.rotation.x ?? 0) * 1000 + (head?.rotation.y ?? 0) * 1000 + (spine?.rotation.x ?? 0) * 1000
      + (this.bones['rightUpperArm']?.rotation.z ?? 0) * 1000 + (this.bones['leftUpperArm']?.rotation.z ?? 0) * 1000;
  }

  private updatePose(dt: number, now: number): void {
    const t = now / 1000;
    const off: Record<string, { x: number; y: number; z: number }> = {};
    const add = (b: string, x = 0, y = 0, z = 0) => { const o = off[b] || (off[b] = { x: 0, y: 0, z: 0 }); o.x += x; o.y += y; o.z += z; };
    for (const [b, r] of Object.entries(REST)) add(b, r.x || 0, r.y || 0, r.z || 0);
    const breath = Math.sin(t * 1.5) * 0.022;
    add('spine', breath * 0.6, Math.sin(t * 0.7) * 0.016, 0);
    add('chest', breath, 0, Math.sin(t * 0.5) * 0.01);
    add('upperChest', breath * 0.5, 0, 0);
    add('head', noise(t * 0.6) * 0.02, noise(t * 0.5 + 2) * 0.03, noise(t * 0.4 + 5) * 0.015);
    this.updateGaze(dt, now);
    add('head', this.gazePitch, this.gazeYaw, 0);
    add('neck', this.gazePitch * 0.3, this.gazeYaw * 0.3, 0);
    if (now < this.speakEnd) add('head', Math.sin(t * 7) * 0.04, Math.sin(t * 3.3) * 0.03, 0);
    for (const a of this.actions) {
      if (!a.def.pose) continue;
      const lt = (now - a.start) / 1000;
      for (const [b, p] of Object.entries(a.def.pose(lt, a.intensity))) add(b, (p.x || 0) * a.weight, (p.y || 0) * a.weight, (p.z || 0) * a.weight);
    }
    for (const [b, node] of Object.entries(this.bones)) { const o = off[b] || { x: 0, y: 0, z: 0 }; node.rotation.set(o.x, o.y, o.z); }
    const hd = off['head'] || { x: 0, y: 0, z: 0 }; const sp = off['spine'] || { x: 0, y: 0, z: 0 };
    this.poseSignature = hd.x * 1000 + hd.y * 1000 + hd.z * 500 + sp.x * 1000 + sp.y * 1000 + (off['rightUpperArm']?.z || 0) * 100;
  }

  private proceduralActive(): string[] {
    const ids: string[] = [];
    if (this.registry) ids.push(this.registry.defaultIdle); else ids.push('idle');
    for (const a of this.actions) ids.push(a.def.name);
    return ids;
  }

  getState() {
    const vrmaWeight = this.vrmaActive && this.vrmaAction ? this.vrmaAction.getEffectiveWeight() : 0;
    const procWeight = this.actions.length ? Math.max(0, ...this.actions.map((a) => a.weight)) : 0;
    return {
      poseSignature: this.poseSignature,
      blinkCount: this.blinkCount,
      blinkValue: this.blinkVal,
      exprHappy: this.exprCur['happy'] ?? 0,
      exprSad: this.exprCur['sad'] ?? 0,
      exprSurprised: this.exprCur['surprised'] ?? 0,
      mouthValue: Math.max(0, ...VISEMES.map((v) => this.mouthCur[v] ?? 0)),
      visemeChanges: this.visemeChanges,
      actionName: this.vrmaActive ? (this.lastMotion || 'vrma') : this.lastAction,
      actionWeight: Math.max(vrmaWeight, procWeight),
      activeActions: this.actions.length + (this.vrmaActive ? 1 : 0),
      valence: this.valence, arousal: this.arousal,
      speaking: performance.now() < this.speakEnd,
      lastExpression: this.lastExpression,
      lastMotion: this.lastMotion,
      lastSayText: this.lastSayText,
      // VRMA performance-layer state
      realVrmaLoaded: this.realVrmaLoaded.slice(),
      realVrmaPlayed: this.realVrmaPlayed.slice(),
      proceduralActive: this.proceduralActive(),
      lastClipSource: this.lastClipSource,
      vrmaActive: this.vrmaActive,
      clientLog: this.clientLog.slice(-10),
    };
  }
}

function buildVisemes(text: string): { t: number; v: string; open: number }[] {
  const out: { t: number; v: string; open: number }[] = [];
  let t = 0;
  const vowel = (c: string): string | null => {
    if ('aá'.includes(c)) return 'aa';
    if (c === 'i') return 'ih'; if (c === 'e') return 'ee';
    if (c === 'o') return 'oh'; if (c === 'u') return 'ou';
    return null;
  };
  for (const raw of text) {
    const c = raw.toLowerCase();
    if (/\s/.test(c)) { out.push({ t, v: 'close', open: 0 }); t += 110; continue; }
    if (/[.,!?;:、。！？]/.test(raw)) { out.push({ t, v: 'close', open: 0 }); t += 220; continue; }
    const vw = vowel(c);
    const v = vw ?? (/[a-z0-9぀-ヿ一-鿿]/.test(c) ? (['aa', 'ih', 'ou', 'ee', 'oh'] as const)[c.charCodeAt(0) % 5] : null);
    if (!v) continue;
    out.push({ t, v, open: vw ? 0.5 + Math.random() * 0.4 : 0.25 + Math.random() * 0.25 });
    t += 80 + Math.random() * 60;
  }
  out.push({ t, v: 'close', open: 0 });
  return out;
}
