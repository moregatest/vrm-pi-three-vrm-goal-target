// Clip registry + selector for the VRMA performance layer.
//
// A "clip" is either a real VRMA file (`source.kind:'vrma'`) or a procedural
// generator (`source.kind:'procedural'`). The agent never picks a clip id — it
// emits a semantic intent; the selector chooses a clip by category / emotion /
// intensity with cooldown + anti-repeat. This file is pure logic (no three.js),
// so it is unit-testable.
export type ClipSource =
  | { kind: 'vrma'; file: string }
  | { kind: 'procedural'; generator: string; params?: Record<string, number> };

export type ClipCategory = 'idle' | 'talk' | 'gesture' | 'reaction' | 'thinking';

export interface ClipDef {
  id: string;
  source: ClipSource;
  category: ClipCategory;
  tags?: string[];
  emotion: string;             // neutral|happy|sad|angry|surprised|relaxed|thinking|…
  intensity?: { min: number; max: number };
  durationMs: number;
  loop?: boolean;
  priority: number;
  bodyParts?: string[];
  blend?: { inMs: number; outMs: number; crossFadeMs?: number };
  cooldownMs?: number;
  variation?: { weight?: number; maxRepeat?: number; cooldownMs?: number };
  runtimeHints?: {
    lookAtMode?: string; expression?: string; expressionWeight?: number; speedMultiplier?: number;
  };
}

export interface Manifest { version?: string; avatarId?: string; defaultIdle?: string; clips: ClipDef[]; }

export interface IntentLike {
  type: string;        // say|emote|gesture|react|think|idle|reset
  emotion?: string;
  intensity?: number;
  gesture?: string;    // e.g. "wave","nod","think"
}

export function intentToCategory(type: string, gesture?: string): ClipCategory {
  switch (type) {
    case 'say': return 'talk';
    case 'gesture': return 'gesture';
    case 'react': case 'emote': return 'reaction';
    case 'think': return 'thinking';
    default: return gesture ? 'gesture' : 'idle';
  }
}

export class ClipRegistry {
  clips: ClipDef[] = [];
  defaultIdle = 'idle_breath_normal';
  private lastPlayedAt: Record<string, number> = {};
  private recent: string[] = [];

  load(m: Manifest): void {
    this.clips = m.clips || [];
    if (m.defaultIdle) this.defaultIdle = m.defaultIdle;
  }
  byId(id: string): ClipDef | undefined { return this.clips.find((c) => c.id === id); }
  vrma(): ClipDef[] { return this.clips.filter((c) => c.source.kind === 'vrma'); }
  procedural(): ClipDef[] { return this.clips.filter((c) => c.source.kind === 'procedural'); }
  idleClips(): ClipDef[] { return this.clips.filter((c) => c.category === 'idle'); }

  markPlayed(id: string, now: number): void {
    this.lastPlayedAt[id] = now;
    this.recent.push(id);
    if (this.recent.length > 8) this.recent.shift();
  }

  /**
   * Pick a clip for an intent. `vrmaReady(id)` lets the caller drop VRMA clips
   * whose file hasn't loaded yet (→ procedural fallback). Returns null if none.
   */
  select(intent: IntentLike, now: number, vrmaReady?: (id: string) => boolean): ClipDef | null {
    const cat = intentToCategory(intent.type, intent.gesture);
    const emo = (intent.emotion || 'neutral').toLowerCase();
    const inten = intent.intensity ?? 0.6;

    let cands = this.clips.filter((c) => c.category === cat);
    // a named gesture narrows by id/tag (e.g. "wave")
    if (intent.gesture) {
      const g = intent.gesture.toLowerCase();
      const named = cands.filter((c) => c.id.toLowerCase().includes(g) || (c.tags || []).map((t) => t.toLowerCase()).includes(g));
      if (named.length) cands = named;
    }
    // emotion-compatible (exact or neutral)
    const emoMatch = cands.filter((c) => c.emotion.toLowerCase() === emo || c.emotion === 'neutral');
    if (emoMatch.length) cands = emoMatch;
    // intensity window (clips without a window always qualify)
    const inWindow = cands.filter((c) => !c.intensity || (inten >= c.intensity.min && inten <= c.intensity.max));
    if (inWindow.length) cands = inWindow;
    // cooldown
    cands = cands.filter((c) => !c.cooldownMs || now - (this.lastPlayedAt[c.id] || 0) >= c.cooldownMs);
    // VRMA clips need their file loaded; otherwise they're not playable yet
    if (vrmaReady) cands = cands.filter((c) => c.source.kind !== 'vrma' || vrmaReady(c.id));

    if (!cands.length) return null;
    return this.weightedAntiRepeat(cands);
  }

  private weightedAntiRepeat(cands: ClipDef[]): ClipDef {
    // prefer clips not played recently; weight by variation.weight
    const scored = cands.map((c) => {
      const recentPenalty = this.recent.includes(c.id) ? 0.25 : 1;
      const w = (c.variation?.weight ?? 1) * recentPenalty;
      return { c, w };
    });
    const total = scored.reduce((s, x) => s + x.w, 0) || 1;
    let r = Math.random() * total;
    for (const x of scored) { r -= x.w; if (r <= 0) return x.c; }
    return scored[scored.length - 1].c;
  }
}
