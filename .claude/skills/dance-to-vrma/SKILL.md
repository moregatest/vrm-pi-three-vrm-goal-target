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
2. OBSERVE Read  <dir>/<n>.contact.png      ← a 4×3 grid of the whole clip
3. DIAGNOSE compare what you see to the symptom→fix table below
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
node tools/make-vrma-from-pose.mjs <dir>/<n>.pose.json /tmp/try.vrma --start 180 --len 120 --legs --hips
node tools/render-vrma-preview.mjs --vrma /tmp/try.vrma --vrm /avatars/default.vrm --out /tmp/try.mp4 --contact-sheet
# then: Read /tmp/try.contact.png
```

## Flags (retarget — what you tune)

| flag | effect | when to use |
|---|---|---|
| `--legs` | retarget upper/lower legs too | legs look frozen/straight (dances use legs) |
| `--hips` | apply hip yaw (body turns) | body never turns / looks too stiff & frontal |
| `--mirror` | swap left/right landmarks | the dance is left-right reversed |
| `--flip-x` / `--flip-y` / `--flip-z` | flip a coordinate axis | whole body faces wrong way / upside-down |
| `--smooth A` | EMA on directions, 0..1 (def 0.4) | raise (0.5–0.7) if jittery; lower (0.2–0.3) if mushy |
| `--damp-head F` | head strength 0..1 (def 0.4) | lower if the head whips around |
| `--damp-spine F` | spine/chest strength 0..1 (def 0.7) | lower if the torso over-leans |
| `--start N` `--len N` | which frames of the pose to use | skip intro/occluded parts; pick the best phrase |

Render flags: `--vrm <path|/url>` (avatar), `--fps`, `--width/--height`, `--gif-width/--gif-fps`, `--contact-sheet` (on by default in `video-to-vrma`), `--no-gif`.

## Diagnosis → fix

| what you SEE in the contact sheet | fix |
|---|---|
| legs straight/frozen the whole time | add `--legs` |
| body always faces front, feels rigid | add `--hips` |
| moves are left-right reversed vs the video | add `--mirror` |
| character faces away / backwards | `--flip-z` (try `--flip-x` if that's wrong) |
| character upside-down or sunk into floor | `--flip-y` |
| arms/legs jitter frame-to-frame | raise `--smooth` to 0.6 |
| motion looks blurred / loses the beat | lower `--smooth` to 0.25 |
| head snaps around unnaturally | lower `--damp-head` to ~0.2 |
| torso bends over too far | lower `--damp-spine` to ~0.4 |
| one limb flails / a segment is broken | that span is occluded — change `--start/--len` to another phrase |

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
# round 1 — baseline
node tools/video-to-vrma.mjs 'https://youtube.com/shorts/XXXX' --out-dir .vrma-out --name d1 --start 180 --len 120
# → Read .vrma-out/d1.contact.png → "legs frozen, body too frontal"
# round 2 — tune (reuse downloaded video via same --out-dir)
node tools/video-to-vrma.mjs 'https://youtube.com/shorts/XXXX' --out-dir .vrma-out --name d2 --start 180 --len 120 --legs --hips
# → Read .vrma-out/d2.contact.png → full-body dance ✓ → deliver d2.gif
```
