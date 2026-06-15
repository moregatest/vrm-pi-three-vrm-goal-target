---
name: dance-to-vrma
description: Use when turning a dance video (YouTube URL or local file) into a good VRMA clip. Downloads/reads the video, generates a .vrma, renders a contact sheet, and ITERATES retarget flags by visually observing the result until the motion looks right. Invoke whenever the user asks to "make a vrma from this video / dance", optimize a generated dance, or fix a retargeted clip that looks wrong.
---

# Dance video → optimized VRMA (observe-and-tune loop)

Turn a dance video into a `.vrma` that plays on a VRM, then **look at the rendered
result and tune until it's good**. You (the AI) are the optimizer: the CLI renders a
**contact sheet** (one PNG of the whole motion) that you Read, judge, and respond to by
changing flags. Repeat until the dance reads correctly.

Project: `/Users/tung/Codes/vrm-pi-three-vrm-goal-target`. Mac, no GPU needed.
Full reference: `docs/video-to-vrma-usage.md`. One-time setup is in that doc (§1).

## The loop

```
1. RUN     node tools/video-to-vrma.mjs <url|file> --out-dir <dir> --name <n> [flags]
2. OBSERVE Read <dir>/<n>.contact.png  AND a SOURCE contact sheet of the real dancer
            (ffmpeg source frames → tile). ALWAYS compare against the target — judging the
            avatar alone makes you accept wrong motion that merely "looks busy".
            e.g.: ffmpeg -i src.mp4 -vf "select=not(mod(n\,20)),scale=150:-1,tile=4x4" -frames:v 1 src.png
3. DIAGNOSE compare avatar-vs-source (match arm/leg positions) to the symptom→fix table below
4. TUNE    re-run with adjusted flags (see Flags). Re-running is cheap once the
           video is downloaded — pass the SAME --out-dir to reuse it.
5. REPEAT  until the contact sheet shows a coherent, correctly-oriented, full-body
           dance with no mirror/flip/jitter. Then show the user the .gif / .mp4.
```

> **Why a contact sheet, not the gif:** the Read tool only sees the **first frame** of a
> GIF. The `.contact.png` tiles 12 evenly-spaced frames into ONE static image, so you can
> judge the entire motion arc at a glance. Always Read the `.contact.png` to decide.

Iterating only on the retarget (after the first run) is much faster — call the two
inner tools directly on the existing `<dir>/<n>.pose.json`:

```
node tools/make-vrma-kalidokit.mjs <dir>/<n>.pose.json /tmp/try.vrma --start 180 --len 120 --face-flip
node tools/render-vrma-preview.mjs --vrma /tmp/try.vrma --vrm /avatars/default.vrm --out /tmp/try.mp4 --contact-sheet
# then: Read /tmp/try.contact.png
```

## Engines & flags (what you tune)

Three retarget engines, pick with `--engine` on `video-to-vrma`:
- **`hybrid`** (DEFAULT) — geometric body (tracks arm/leg **positions** + correct facing, self-consistent with our rig) + **Kalidokit fingers** (MediaPipe HandLandmarker). Most reliable on real footage.
- **`simple`** — same geometric body, no fingers.
- **`kalidokit`** — full Kalidokit body (adds limb twist) BUT its rotations assume a VRM-normalized bone-axis our hand-built rig doesn't match → **arms shoot overhead**. Avoid unless you fix the rig axes.

**Kalidokit flags** (`make-vrma-kalidokit.mjs`, also accepted by `video-to-vrma`):

| flag | effect | when to use |
|---|---|---|
| `--face-flip` | rotate whole avatar 180° about Y | avatar faces **away/back** — common for 3rd-person video (Kalidokit assumes selfie facing) |
| `--mirror` | un-mirror (swap L/R + flip yaw/roll) | moves are left-right reversed vs the video |
| `--flat-hips` | zero hips yaw | body over-spins / keeps turning away |
| `--smooth A` | EMA on output quats 0..1 (def 0.3) | raise 0.5–0.7 if jittery; lower ~0.15 if mushy |
| `--no-legs` | skip legs | legs noisy/occluded and distracting |
| `--no-fingers` | skip finger solving | hands jitter / fingers not needed |
| `--start N` `--len N` | pose segment | skip intro/occluded parts; pick the best phrase |

**Simple-engine flags** (`--engine simple`): `--legs`, `--hips`, `--mirror`, `--flip-x/y/z`, `--smooth`, `--damp-head`, `--damp-spine`, `--start/--len`.

Render flags: `--vrm <path|/url>`, `--fps`, `--width/--height`, `--gif-width/--gif-fps`, `--contact-sheet` (on by default in `video-to-vrma`), `--no-gif`, `--zoom`/`--aim` (closer crop). **Fingers are tiny in a full-body sheet** — to check hands, render a second sheet zoomed in, e.g. `--zoom 0.6 --aim 0.85`.

## Diagnosis → fix (kalidokit, the default)

| what you SEE in the contact sheet | fix |
|---|---|
| avatar faces **away / back** | `--face-flip` |
| body over-spins / keeps turning away | `--flat-hips` |
| moves are left-right reversed vs the video | `--mirror` |
| arms/legs jitter frame-to-frame | raise `--smooth` to 0.5–0.7 |
| motion mushy / loses the beat | lower `--smooth` to ~0.15 |
| legs noisy / distracting | `--no-legs` |
| one limb flails / a segment is broken | that span is occluded — change `--start/--len` |
| arms look stiff / no twist | you're on `--engine simple` → use kalidokit (default) |

(Simple engine extras: legs frozen → `--legs`; too frontal/rigid → `--hips`; wrong facing → `--flip-z`/`--flip-x`; upside-down → `--flip-y`.)

## Stop when

The contact sheet shows: full body engaged (arms **and** legs), correct facing, no
mirroring, smooth (no jitter), recognizable as the source dance. Then deliver
`<dir>/<n>.gif` + `<dir>/<n>.mp4` to the user.

## Integrate the result

Drop the tuned `.vrma` into `public/vrma/` and add one entry to `public/vrma/clips.json`
(`source.kind: "vrma"`); the runtime auto-loads it (see `docs/dance-video-to-vrma-plan.md` §6).

## Licensing (must respect)

Output derived from someone else's video (e.g. a YouTube short) is for **local use only** —
do not commit or redistribute it. The tool prints `LOCAL ONLY` for URL inputs, and
`./.vrma-out/` + video-derived files are gitignored. Committable/shareable clips must use
self-made or licensed/CC0 source video.

## Example session

```
# round 1 — baseline (kalidokit is the default engine)
node tools/video-to-vrma.mjs 'https://youtube.com/shorts/XXXX' --out-dir .vrma-out --name d1 --start 30 --len 150
# → Read .vrma-out/d1.contact.png → "avatar faces away / back"
# round 2 — tune fast on the kept pose.json (no re-download), then re-render
node tools/make-vrma-kalidokit.mjs .vrma-out/d1.pose.json /tmp/d2.vrma --start 30 --len 150 --face-flip
node tools/render-vrma-preview.mjs --vrma /tmp/d2.vrma --vrm /avatars/default.vrm --out /tmp/d2.mp4 --contact-sheet
# → Read /tmp/d2.contact.png → front-facing, expressive arms ✓ → deliver
```

> Real example (this repo): the example short needed exactly `--face-flip` — Kalidokit's
> selfie-facing convention put the avatar's back to camera; one flag fixed it.
