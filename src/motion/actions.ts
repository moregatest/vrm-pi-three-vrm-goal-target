// Procedural action presets for the gesture layer.
//
// Each action contributes *additive* bone offsets (radians, on top of the rest
// pose) and optional expression targets, both scaled by the scheduler's blend
// weight. The agent only ever names an action ("wave", "thinking", …) — no raw
// bones are exposed.
export type BoneOffset = { x?: number; y?: number; z?: number };
export type Pose = Record<string, BoneOffset>;

export interface ActionDef {
  name: string;
  durationMs: number; // one-shot length (ignored when loop=true)
  blendInMs: number;
  blendOutMs: number;
  priority: number;
  loop?: boolean;
  /** additive bone offsets at local time tSec, pre-weight */
  pose?: (tSec: number, intensity: number) => Pose;
  /** expression targets contributed while active, pre-weight */
  expression?: (tSec: number, intensity: number) => Record<string, number>;
}

const env = (t: number, k = 2.5) => Math.exp(-t * k); // decay envelope for "spike" actions

export const ACTIONS: Record<string, ActionDef> = {
  // right-arm wave (rest rightUpperArm.z≈1.0 → raised ≈ -1.25)
  wave: {
    name: 'wave', durationMs: 3000, blendInMs: 260, blendOutMs: 600, priority: 5,
    pose: (t, i) => ({
      rightUpperArm: { z: -2.25 * i },
      rightLowerArm: { z: (0.45 + Math.sin(t * 9) * 0.55) * i },
      head: { y: -0.05 * i },
    }),
  },
  happy_wave: {
    name: 'happy_wave', durationMs: 3200, blendInMs: 260, blendOutMs: 600, priority: 5,
    pose: (t, i) => ({
      rightUpperArm: { z: -2.25 * i },
      rightLowerArm: { z: (0.45 + Math.sin(t * 9) * 0.55) * i },
      head: { y: -0.05 * i, x: -0.04 * i },
    }),
    expression: (_t, i) => ({ happy: 0.85 * i }),
  },
  nod: {
    name: 'nod', durationMs: 1500, blendInMs: 120, blendOutMs: 320, priority: 4,
    pose: (t, i) => ({ head: { x: Math.sin(t * 6) * 0.18 * i }, neck: { x: Math.sin(t * 6) * 0.05 * i } }),
  },
  small_nod: {
    name: 'small_nod', durationMs: 1200, blendInMs: 120, blendOutMs: 300, priority: 4,
    pose: (t, i) => ({ head: { x: Math.sin(t * 6.5) * 0.12 * i } }),
  },
  thinking: {
    name: 'thinking', durationMs: 3600, blendInMs: 320, blendOutMs: 520, priority: 4,
    pose: (t, i) => ({
      rightUpperArm: { z: -1.2 * i, x: -0.15 * i },
      rightLowerArm: { z: 1.5 * i },
      head: { y: 0.14 * i, x: 0.08 * i + Math.sin(t * 1.3) * 0.03 * i },
    }),
    expression: (_t, i) => ({ relaxed: 0.3 * i }),
  },
  surprised_recoil: {
    name: 'surprised_recoil', durationMs: 1300, blendInMs: 80, blendOutMs: 520, priority: 7,
    pose: (t, i) => {
      const e = env(t, 3);
      return {
        spine: { x: -0.18 * i * e }, chest: { x: -0.1 * i * e },
        leftShoulder: { z: -0.22 * i * e }, rightShoulder: { z: 0.22 * i * e },
        head: { x: -0.14 * i * e },
      };
    },
    expression: (t, i) => ({ surprised: i * env(t, 1.4) }),
  },
  sad_slump: {
    name: 'sad_slump', durationMs: 3500, blendInMs: 420, blendOutMs: 720, priority: 4,
    pose: (_t, i) => ({
      spine: { x: 0.18 * i }, chest: { x: 0.1 * i }, neck: { x: 0.14 * i }, head: { x: 0.18 * i },
      leftShoulder: { z: 0.16 * i }, rightShoulder: { z: -0.16 * i },
    }),
    expression: (_t, i) => ({ sad: 0.7 * i }),
  },
  sleepy_relax: {
    name: 'sleepy_relax', durationMs: 6000, blendInMs: 600, blendOutMs: 820, priority: 3,
    pose: (t, i) => ({ head: { z: 0.18 * i, x: 0.07 * i }, spine: { x: 0.06 * i } }),
    expression: (_t, i) => ({ relaxed: 0.7 * i }),
  },
};

// legacy vrm_motion enum → action name
export const MOTION_ALIAS: Record<string, string> = { wave: 'wave', nod: 'nod' };
