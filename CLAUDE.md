# CLAUDE.md — VRM · Pi · three-vrm

Guidance for Claude Code (and humans) working in this repo.

## What this is

A **real** browser [three-vrm](https://github.com/pixiv/three-vrm) runtime for a VRM avatar (not a mock), drivable two ways:

1. **Agent mode** — a Pi agent (or any HTTP client) calls high-level *semantic* VRM tools over a local HTTP + SSE bridge; the avatar reacts (expression / motion / speech).
2. **Standalone mode** — a Tauri desktop app whose **Rust backend watches the system** (CPU, memory, battery, clock) and **autonomously** drives the avatar via a deterministic **rules engine**. No model, no network.

Both modes share one frontend and support **runtime VRM swapping**.

It is verified end-to-end (real WebGL2 render + pixel checks, Rust unit tests, a real Pi/agent round) — see **Verification**.

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
| `src/main.ts` | three-vrm runtime: render loop, expression / motion (`wave`, `nod`) / speech, `loadVrm()` runtime swap, SSE **and** Tauri transports, avatar dropdown, DOM state on `window.__VRM_STATE__` + `#vrm-state`. |
| `server/vrm-api.mjs` | Express bridge: `POST /vrm/{say,expression,motion,reset,load}`, `GET /vrm/{events (SSE), avatars, health}`; appends every call to a JSONL log. |
| `pi/AGENTS.md` | The **Aria** character + rules telling Pi to *use the tools*, not narrate. |
| `pi/vrm-tools.ts` | pi extension: 4 semantic tools `vrm_say` / `vrm_expression` / `vrm_motion` / `vrm_reset` → POST to the API. Loaded with `pi -e pi/vrm-tools.ts --no-builtin-tools -t vrm_say,vrm_expression,vrm_motion,vrm_reset`. No shell / raw bones exposed. |
| `src-tauri/src/rules.rs` | **Pure, unit-tested** rules engine: `decide(SystemState, &mut RuleMemory) -> Vec<VrmAction>` with cooldown / hysteresis / rising-edge. Edit this to change autonomous behavior. |
| `src-tauri/src/sensors.rs` | CPU % + memory % (`sysinfo`), battery level/charging (`pmset`), local clock. |
| `src-tauri/src/main.rs` | Tauri app: 2 s tick loop emits `vrm-event`; commands `list_avatars` / `load_avatar`. |
| `public/avatars/*.vrm` | Swappable avatars (+ `SOURCES.md` with per-file licenses). |
| `bin/pi` | Wrapper that drives the **handless** round via OpenRouter (see Model notes). |
| `proof-{a,b,c,d}.mjs` | Verification harnesses (see below). |

## Avatars — add & swap

Drop a `.vrm` into `public/avatars/`; it appears in the dropdown automatically (`list_avatars` in Tauri, `GET /vrm/avatars` in the browser). Swap at runtime via the dropdown, `?vrm=<name>`, `POST /vrm/load {"name":"x.vrm"}`, or Tauri `load_avatar(name)`.

**Facing:** the VRM 1.0 sample faces +Z (toward the camera); VRM 0.x faces −Z, so `main.ts` flips VRM0 models 180°. The relax-pose (`relaxArms`) is tuned for the default avatar; other rigs may rest differently (cosmetic only).

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
node proof-d.mjs                                   # runtime VRM swap (default → sendagaya), still renders
( cd src-tauri && cargo test )                     # rules-engine unit tests (5)
```

Artifacts: `proof-a-screenshot.png`, `proof-c-screenshot.png`, `proof-d-screenshot.png`, `events.*.jsonl`, and preserved handless evidence in `proofs/handless-evidence/`.

## Tauri / Rust

Needs the Rust toolchain (`rustup`; ensure `~/.cargo/bin` is on PATH for `cargo`/`tauri`). `src-tauri/` is the app crate (`tauri` 2, `sysinfo`, `chrono`). macOS WKWebView provides WebGL2. `tauri.conf.json` sets the window and bundles `public/avatars` as a resource; `bin` (in package.json scripts) → `tauri dev` / `tauri build`.

## Design / spec

`docs/superpowers/specs/2026-06-14-standalone-vrm-desktop-pet-design.md`. The original PoC's asset license is in `README.md` / `ASSET_LICENSE.txt`.
