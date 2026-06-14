# Standalone Autonomous VRM Desktop Pet — Design

- **Date:** 2026-06-14
- **Project:** `vrm-pi-three-vrm-goal-target`
- **Status:** approved (brainstorm)

## Goal

Make the VRM avatar run **standalone** as a desktop app that:
1. detects **system state** and **auto-generates actions** (expression / motion / speech) via a deterministic rules engine, and
2. supports **swapping to a specified VRM at runtime**.

The existing Pi-agent / Node-API / SSE path and all proofs (A/B/C) stay intact — standalone is an *added* mode, not a replacement.

## Approved decisions

- **Auto-action engine:** pure deterministic **rules** (no LLM) — truly self-sufficient, zero cost/latency.
- **Packaging:** **Tauri** desktop app (Rust backend + macOS WKWebView). Requires installing the Rust toolchain.
- **VRM swap:** auto-scan `avatars/` + frontend **dropdown** + Tauri command, plus a kept Node `POST /vrm/load` and a `?vrm=` URL param.

## Architecture

Two run modes share **one** frontend (the proven three-vrm runtime):

- **Agent mode (existing):** Node VRM API + SSE; the Pi agent calls semantic tools. Unchanged.
- **Standalone mode (new):** Tauri app; the Rust backend samples the system and runs the rules engine, pushing actions to the webview over Tauri IPC events.

Frontend event handlers (`setExpression` / `startMotion` / `say` / `loadVrm`) are **transport-agnostic** — fed by SSE (agent) *or* Tauri events (standalone). Tauri code is loaded only when running inside the Tauri webview (guarded dynamic import), so the plain-browser proofs keep working.

## Components (isolated units)

- `src/main.ts` (refactor): `loadVrm(url)` (dispose current VRM via `VRMUtils.deepDispose`, load new, re-frame camera, reset state); a guarded Tauri `listen('vrm-event')`; an avatar `<select>` dropdown; `?vrm=` param.
- `src-tauri/src/sensors.rs`: `sysinfo`-based sampling — CPU %, memory %, battery (level / charging), uptime, wall clock — on a ~2 s tick.
- `src-tauri/src/rules.rs`: **pure, unit-tested** `decide(state, &mut RuleMemory) -> Vec<VrmAction>` with per-action cooldown + hysteresis + rising-edge detection.
- `src-tauri/src/main.rs`: tick loop emits `vrm-event`; Tauri commands `list_avatars()` and `load_avatar(name)`.
- `server/vrm-api.mjs`: add `POST /vrm/load {name|url}` (broadcast `{type:"load",url}`) and `GET /vrm/avatars` (list) for the agent/browser path.
- `avatars/`: `*.vrm` files (seeded with the existing avatar). Documented how to add more.
- `src-tauri/tauri.conf.json`: window config, `avatars/` + web build as resources.

## Rules (initial table)

| condition | action(s) |
|---|---|
| CPU > 85% (sustained) | expression `angry` + say "Phew, flat out!" |
| CPU > 70% | expression `surprised` |
| memory > 85% | expression `sad` |
| battery < 20% & discharging | expression `sad` + say "battery's getting low…" |
| battery starts charging (rising edge) | expression `happy` + motion `wave` + say "Ah, power!" |
| top of the hour (rising edge) | motion `wave` + say "&lt;H&gt; o'clock!" |
| idle (CPU < 25%) for > 60 s | expression `relaxed` |
| periodic while idle (~45 s) | motion `nod` (liveliness) |

Emission guards: only on **state change / rising edge**, with a per-action **cooldown**, so the avatar never spams.

## VRM swap

`list_avatars()` scans `avatars/`; the dropdown lists names; selecting → `load_avatar(name)` → emit `{type:"load", url}` → `loadVrm()` disposes the old VRM and loads the new one, re-frames, resets state. Also reachable via `?vrm=<name>` and Node `POST /vrm/load` (→ SSE → `loadVrm`).

## Testing

- `rules.rs`: `cargo test` — thresholds, hysteresis, cooldown, rising-edge.
- Render smoke: a browser check (reuse the Proof-A approach) that WebGL2 is up, a **swapped** VRM loads, and a pushed rule-action is reflected in the DOM.
- Regression: existing proofs A/B/C must still pass (frontend changes are additive + guarded).

## Build / run

- Standalone: `npx tauri dev` (dev) / `npx tauri build` (package `.app`/`.dmg`).
- Agent mode: unchanged (`npm run api` + `npm run dev`; `node proof-*.mjs`).

## Out of scope (YAGNI)

LLM-driven actions, audio/TTS lip-sync, network/temperature sensors, multi-window, tray menu.

## Deliverable

Working Tauri standalone pet with autonomous system-driven actions + runtime VRM swap, **plus a project `CLAUDE.md`** documenting both modes and how to run/extend.
