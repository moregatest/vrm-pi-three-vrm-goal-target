# CLAUDE.md — VRM · Pi · three-vrm

Guidance for Claude Code (and humans) working in this repo.

## What this is

A **real** browser [three-vrm](https://github.com/pixiv/three-vrm) runtime for a VRM avatar (not a mock), drivable two ways:

1. **Agent mode** — a Pi agent (or any HTTP client) calls high-level *semantic* VRM tools over a local HTTP + SSE bridge; the avatar reacts (expression / motion / speech).
2. **Standalone mode** — a Tauri desktop app whose **Rust backend watches the system** (CPU, memory, battery, clock) and **autonomously** drives the avatar via a deterministic **rules engine**. No model, no network.

Both modes share one frontend and support **runtime VRM swapping**.

Between the events and the rig sits a **continuous character control layer** (`src/motion/`) that keeps the avatar *alive*: idle breathing/sway/head-micro-motion, natural blink, gaze, affect-damped (non-snapping) expressions, a pseudo-viseme mouth, and a blended action scheduler — so discrete semantic events become continuous, layered motion.

It is verified end-to-end (real WebGL2 render + pixel checks, an aliveness proof, Rust unit tests, a real Pi/agent round) — see **Verification**.

## Quick start

```bash
npm install

# --- Standalone desktop pet (system-aware, rules-driven) ---
npm run tauri:dev      # run it (needs the Rust toolchain: ~/.cargo/bin on PATH)
npm run tauri:build    # package a distributable .app / .dmg

# --- Agent mode (Pi / HTTP drives the avatar) ---
npm run api            # VRM API + SSE bridge (:8970)
npm run dev            # browser runtime (Vite, :5173 dev / :5180 in proofs)
```

## Architecture — one frontend, two transports

`src/main.ts` exposes transport-agnostic handlers (`setExpression` / `startMotion` / `say` / `loadVrm`) fed by **either** transport:

```
Agent mode:    Pi agent ─▶ pi/vrm-tools.ts ─▶ POST /vrm/* ─▶ server/vrm-api.mjs ─▶ SSE ─▶ main.ts ─▶ three-vrm
Standalone:    src-tauri (sensors ─▶ rules) ─▶ emit "vrm-event" ─▶ main.ts ─▶ three-vrm
VRM swap (both): dropdown / load_avatar / POST /vrm/load / ?vrm=<name> ─▶ loadVrm()
```

The frontend picks the transport at boot: if it is inside the Tauri webview (`window.__TAURI__`) it listens to Tauri IPC; otherwise it connects to the Node SSE bridge. So the browser proofs and the desktop app run the *same* rendering code.

## Key files

| Path | Role |
|------|------|
| `src/main.ts` | **Slim** entry: renderer/scene/camera, `loadVrm()` runtime swap (head-bone framing), SSE **and** Tauri transports, avatar dropdown, base DOM state. Delegates all animation to the MotionController. |
| `src/motion/MotionController.ts` | The **continuous character control layer** + **VRMA mixer**: idle (breathing/sway/head-micro), face (affect→expression, damped), blink, gaze, pseudo-viseme mouth, blended ActionScheduler, AND a `THREE.AnimationMixer` that plays real `.vrma` clips (procedural kept as an additive micro-overlay during a clip). `handleEvent()`+`update(dt,now)`+`getState()` (metrics inc. `realVrmaLoaded/realVrmaPlayed/proceduralActive/lastClipSource`) → `window.__VRM_STATE__`. |
| `src/motion/actions.ts` | Procedural action presets (wave, happy_wave, nod, thinking, surprised_recoil, sad_slump, sleepy_relax) as additive bone-offset + expression generators. |
| `src/motion/clips.ts` | VRMA performance layer: `ClipRegistry` + intent **selector** over the `vrma`/`procedural` manifest (`public/vrma/clips.json`), with cooldown + anti-repeat. Pure logic. |
| `public/vrma/` | `clips.json` manifest + `gesture_wave_01.vrma` (real **MIT** pixiv clip — the verification anchor) + `SOURCES.md`. |
| `server/vrm-api.mjs` | Express bridge: `POST /vrm/{say,expression,motion,reset,load,action,mood}`, `GET /vrm/{events (SSE), avatars, health}`; appends every call to a JSONL log. |
| `pi/AGENTS.md` | The **Aria** character + rules telling Pi to *use the tools*, not narrate. |
| `pi/vrm-tools.ts` | pi extension: semantic tools `vrm_say` / `vrm_expression` / `vrm_motion` / `vrm_reset` / `vrm_action` / `vrm_mood` → POST to the API. No shell / raw bones exposed. |
| `src-tauri/src/rules.rs` | **Pure, unit-tested** rules engine: `decide(SystemState, &mut RuleMemory) -> Vec<VrmAction>` with cooldown / hysteresis / rising-edge. Edit this to change autonomous behavior. |
| `src-tauri/src/sensors.rs` | CPU % + memory % (`sysinfo`), battery level/charging (`pmset`), local clock. |
| `src-tauri/src/main.rs` | Tauri app: 2 s tick loop emits `vrm-event`; commands `list_avatars` / `load_avatar`. |
| `public/avatars/*.vrm` | Swappable avatars (+ `SOURCES.md` with per-file licenses). |
| `bin/pi` | Wrapper that drives the **handless** round via OpenRouter (see Model notes). |
| `proof-{a,b,c,d,e}.mjs` | Verification harnesses (see below). |

## Avatars — add & swap

Drop a `.vrm` into `public/avatars/`; it appears in the dropdown automatically (`list_avatars` in Tauri, `GET /vrm/avatars` in the browser). Swap at runtime via the dropdown, `?vrm=<name>`, `POST /vrm/load {"name":"x.vrm"}`, or Tauri `load_avatar(name)`.

**Default avatar:** `public/avatars/user-avatar.vrm` ("Celeste", user-provided). **Facing:** VRM 1.0 faces +Z (toward the camera); VRM 0.x faces −Z, so `main.ts` flips VRM0 180°. **Framing** aims at the head bone (robust across models). The rest-pose lives in `MotionController`; other rigs may rest differently (cosmetic).

## Motion control layer (`src/motion/`)

Discrete events never touch bones directly — `MotionController` turns them into **continuous, layered, blended** motion:

- **idle** (always on): breathing (spine/chest sine), body sway, head micro-motion (pseudo-noise).
- **face**: an affect model (`valence`/`arousal`, decays → emotional residue) + explicit overrides → expression *targets*, **damped** each frame (no snapping; expressions stack).
- **blink**: natural 1.4–4.8 s timing (+ occasional double-blink), fast damped close/open.
- **gaze**: idle random targets / look-forward while speaking / follow the mouse in the browser.
- **mouth**: `say(text)` → pseudo-viseme timeline (aa/ih/ee/oh/ou + close on punctuation), smoothed.
- **ActionScheduler** (`actions.ts`): named actions play with **blend-in/out**, intensity, priority; same-name cross-fades, different actions stack.

New semantic events/tools (still no raw bones): `POST /vrm/action {name,intensity?,durationMs?,…}` → `vrm_action`; `POST /vrm/mood {mood,strength?,decayMs?}` → `vrm_mood`.

### VRMA performance clip layer (built)

Hybrid, manifest-driven: each clip in `public/vrma/clips.json` is `source: { kind:'vrma', file } | { kind:'procedural', generator }`. The agent emits a semantic intent (`wave`, `nod`, `think`, …); the **selector** (`clips.ts`) picks a clip by category/emotion/intensity (cooldown + anti-repeat). Real `.vrma` clips play through `@pixiv/three-vrm-animation` `createVRMAnimationClip` + a `THREE.AnimationMixer`; while a clip plays, the procedural layer continues as an **additive micro-overlay** (breathing/blink/gaze) so the avatar never freezes, and the torso is kept upright/forward so a generic clip's arm motion reads as a clean gesture. If a requested VRMA isn't loaded, it falls back to a loaded VRMA (logged) or a procedural action.

- **Asset reality:** the only clearly-permissive `.vrma` is pixiv's MIT sample (`gesture_wave_01.vrma`) — used as the *anchor* that proves the pipeline. Everyday liveliness is procedural (per the design: "real VRMA = signature/anchor; procedural = daily 靈動"). Drop a polished wave `.vrma` + manifest entry to upgrade — no code change.
- **Runtime state** (for proofs): `realVrmaLoaded`, `realVrmaPlayed`, `proceduralActive`, `lastClipSource`, plus a `clientLog` of intent/clip events.

## Rules engine (standalone autopilot)

Defined in `src-tauri/src/rules.rs`; only fires on change / rising edge so it never spams:

| condition | action(s) |
|---|---|
| CPU > 85% | `expression angry` + say "Phew, I'm flat out here!" |
| CPU > 70% | `expression surprised` |
| memory > 85% | `expression sad` |
| battery < 20% & discharging | `expression sad` + say "My battery's getting low…" |
| charging (rising edge) | `expression happy` + `motion wave` + say "Ah, power!" |
| top of the hour (once) | `motion wave` + say "It's N o'clock!" |
| idle (CPU < 25%) | `expression relaxed` + occasional `motion nod` |

## Model notes (IMPORTANT — saves re-debugging)

- The **agent** runs on the **local Qwen 3.6 27B** (`llama-server`) in pi **text mode + `--thinking off`** (~13 s, reliable tool calls — see Proof B). `--thinking minimal`/`high` makes this reasoning model generate endlessly.
- pi's **`--mode json`** (which **handless-termal forces**) does **not** complete in practical time on this local model. So the **handless round (Proof C) uses OpenRouter `deepseek/deepseek-v4-flash`** via `bin/pi` (a wrapper named `pi` that injects the extension + `--provider openrouter`). Everything else stays local.
- `llama-server` has a **single slot (`-np 1`)**: a *killed* json run keeps generating and blocks the next request. Let runs finish; `pi --no-tools -p "PONG"` (≈3-8 s) confirms the slot is free.

## Verification

```bash
node proof-a.mjs                                   # render: direct API → real-GPU browser, pixel check, screenshot
node proof-b.mjs                                   # local-Qwen agent → tools → events.proof-b.jsonl (happy/wave/say)
bash proofs/setup-handless.sh && node proof-c.mjs  # handless-termal ht run-round → agent → browser E2E
node proof-d.mjs                                   # runtime VRM swap, still renders
node proof-e.mjs                                   # ALIVENESS: idle micro-motion, blink, expression ramp, action blend, viseme mouth
node proof-f.mjs                                   # VRMA LAYER: real .vrma loaded+played, >=3 procedural, idle-before-event, agent wave→vrma
node proof-g.mjs                                   # GENERATED .vrma: programmatic clip loaded+played by the runtime
node proof-h.mjs                                   # PREVIEW: render .vrma+VRM → MP4/GIF (synthetic demo, committable)
( cd src-tauri && cargo test )                     # rules-engine unit tests (5)
```

Artifacts: `proof-{a,c,d,e}-screenshot.png`, `events.*.jsonl`, and preserved handless evidence in `proofs/handless-evidence/`.

## Tauri / Rust

Needs the Rust toolchain (`rustup`; ensure `~/.cargo/bin` is on PATH for `cargo`/`tauri`). `src-tauri/` is the app crate (`tauri` 2, `sysinfo`, `chrono`). macOS WKWebView provides WebGL2. `tauri.conf.json` sets the window and bundles `public/avatars` as a resource; `bin` (in package.json scripts) → `tauri dev` / `tauri build`.

## Design / spec

`docs/superpowers/specs/2026-06-14-standalone-vrm-desktop-pet-design.md`. The original PoC's asset license is in `README.md` / `ASSET_LICENSE.txt`.

**Dance-video → VRMA pipeline:** `docs/dance-video-to-vrma-plan.md` — research (cited) + a working PoC. `tools/make-vrma.mjs` programmatically writes a valid `.vrma` from per-bone keyframes (synthetic dance → `public/vrma/generated_demo.vrma`, the committable `generated_dance` clip), verified by `proof-g.mjs`. `tools/extract_pose.py` (MediaPipe) + `tools/make-vrma-from-pose.mjs` close the real loop (video → pose → retarget → `.vrma`); video-derived outputs are **gitignored** for licensing. A Mac CLI wraps it end-to-end — `tools/video-to-vrma.mjs <url|file>` → `.vrma` + a rendered **preview** (`tools/render-vrma-preview.mjs`: headless three-vrm steps the clip frame-by-frame → MP4/GIF). Usage: `docs/video-to-vrma-usage.md`; verified by `proof-h.mjs` (committable demo `docs/images/preview-demo.gif`). The retarget is **flag-tunable** (`--legs/--hips/--mirror/--flip-x|y|z/--smooth/--damp-*`) and `render-vrma-preview --contact-sheet` emits a 12-frame montage PNG so an **AI can observe the result and iterate** — codified as the loadable project skill `.claude/skills/dance-to-vrma/SKILL.md` (observe → diagnose → tune loop). Default retarget engine is **Kalidokit** (`tools/make-vrma-kalidokit.mjs` — proper kinematics + limb twist + wrists + legs; `--engine simple` is the naive shortest-arc fallback); `--face-flip` corrects Kalidokit's selfie-facing convention on 3rd-person video.
