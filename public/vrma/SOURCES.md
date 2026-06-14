# VRMA (VRM Animation) Asset Sources & Licenses

VRM Animation files (`.vrma`) in this directory. A `.vrma` is a glTF binary
carrying the `VRMC_vrm_animation` extension (humanoid bone animation + optional
expression / lookAt), loaded by `@pixiv/three-vrm-animation`
(`createVRMAnimationClip`) and played through a three.js `AnimationMixer`.

Only **clearly permissive** files are placed here. See "Rejected candidates"
below for files that were verified technically valid but had unclear /
non-permissive licenses and were therefore **not** added.

---

## gesture_wave_01.vrma  ✅ MIT — safe to commit/redistribute

| Field | Value |
|-------|-------|
| Filename | `gesture_wave_01.vrma` |
| Original name | `test.vrma` |
| Motion | Humanoid right-arm raise gesture + `happy` expression + lookAt head-turn (a minimal greeting/wave-style gesture). 7 keyframes, 0.0–3.0 s. |
| Size | 11,548 bytes |
| SHA-256 | `38d0fd12d61e896f1a970b5e358ebb41a96c8d5ee8e284496ea18f0ba1f04e7b` |
| glTF generator | `VRM Add-on for Blender v2.20.4 / handwritten` |
| VRMA spec | `VRMC_vrm_animation` specVersion `1.0` (full humanoid humanBones map + `happy` preset expression + lookAt) |
| Repository | https://github.com/pixiv/three-vrm  (official pixiv three-vrm) |
| Source URL (branch) | https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm-animation/examples/models/test.vrma |
| Source URL (pinned commit) | https://raw.githubusercontent.com/pixiv/three-vrm/63dd83ce7834b4b8ffaedda71c7d8e5fffa421dd/packages/three-vrm-animation/examples/models/test.vrma |
| jsDelivr mirror | https://cdn.jsdelivr.net/gh/pixiv/three-vrm@dev/packages/three-vrm-animation/examples/models/test.vrma |
| Retrieved | 2026-06-14 |

### License — MIT
The file lives in pixiv's official `three-vrm` repository, which is covered by a
single top-level **MIT License** (there is no separate asset/NOTICE license
anywhere in the repo, and the file's own generator metadata —
"VRM Add-on for Blender … / handwritten" — shows it was authored by the pixiv
team as the package's example/test fixture, not imported from a third party).

```
Copyright (c) 2019-2026 pixiv Inc.

MIT License

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, ...
```
Full text: https://raw.githubusercontent.com/pixiv/three-vrm/dev/LICENSE

MIT permits use, modification, redistribution and commercial use; only the
copyright + permission notice must be retained (this file satisfies that).
This is the same source/license the repo already uses for its sample avatar
(`/ASSET_LICENSE.txt`).

### Verification (performed 2026-06-14)
```
$ xxd -l 16 gesture_wave_01.vrma
00000000: 676c 5446 0200 0000 1c2d 0000 b02b 0000  glTF.....-...+..
        # first 4 bytes = 67 6C 54 46 = "glTF"  ✓ (glTF binary, version 2)

$ strings gesture_wave_01.vrma | grep -m1 VRMC_vrm_animation
VRMC_vrm_animation                                              ✓

$ file gesture_wave_01.vrma
gesture_wave_01.vrma: glTF binary model, version 2, length 11548 bytes

$ shasum -a 256 gesture_wave_01.vrma
38d0fd12d61e896f1a970b5e358ebb41a96c8d5ee8e284496ea18f0ba1f04e7b
```
Decoded contents: 1 animation, channels target `rightUpperArm` (rotation),
the `happy` expression node, and the `lookAt` node; `extensionsUsed`
= `["VRMC_vrm_animation"]`; full VRM-humanoid bone map present.

---

## Rejected candidates (verified valid `.vrma`, but NOT permissive — not added)

Honesty note: a nicer, full-length **"Greeting" / wave** motion exists, but every
copy traces back to a license that forbids redistribution, so none could be
committed to this repo. They are recorded here for transparency.

### VRoid Project official "VRMA_02 Greeting" (the ideal motion) — REJECTED (no redistribution)
- Motion: full-body greeting / wave (`VRMA_02`), part of the official set of 7
  free sample motions: VRMA_01 Show full body, **VRMA_02 Greeting**, VRMA_03
  Peace sign, VRMA_04 Shoot, VRMA_05 Spin, VRMA_06 Model pose, VRMA_07 Squat.
- Author / source: **pixiv Inc. — VRoid Project** (official).
  - Announcement: https://vroid.com/en/news/6HozzBIV0KkcKf9dc1fZGW
  - Official distribution (free): https://vroid.booth.pm/items/5512385 (BOOTH;
    requires the BOOTH "purchase" flow — at time of access the listing returned
    HTTP 403 / shown as private).
- License terms (from the official announcement / BOOTH page):
  - Free to use; **commercial use allowed** (individuals & corporations);
    modification allowed ("freely customize the data").
  - **Credit REQUIRED:** "Character animation credits to pixiv Inc.'s VRoid Project"
    (JP: 「キャラクターアニメーション: ピクシブ株式会社 VRoidプロジェクト」).
  - **Redistribution PROHIBITED** "in an extractable state" without permission;
    plus restrictions (no religious/political use, no defamation, no illegal /
    sexual / violent use).
- Why rejected: committing the raw `.vrma` into this repo's `public/vrma/` is
  redistribution in an extractable form, which the license forbids. It is NOT a
  permissive (CC0/MIT-style) license, so it fails this task's requirement. (It is
  fine to *download and use locally* with the credit line — just not to vendor.)

### GitHub mirrors of the VRoid set — REJECTED (license can't be relicensed)
- `not-elm/bevy_vrm1` (dual MIT/Apache-2.0 **code** license) ships
  `assets/vrma/VRMA_01.vrma`, `VRMA_02.vrma`, `VRMA_03.vrma`.
  - I downloaded `VRMA_02.vrma` (238,948 bytes, sha256
    `95cf2785100c2a68966e2f47dcd2e286d4d03c8c45d7fc072d6cc2c27a5e10f8`,
    generator "VRM Add-on for Blender v3.6.2") and verified it: valid glTF
    binary with `VRMC_vrm_animation`, full humanoid armature — i.e. the real
    Greeting motion.
  - Rejected: filenames + content are the pixiv VRoid sample set, whose terms
    (credit required, no redistribution) govern the assets regardless of the
    repo's blanket code license. The repo's README credits only the VRM *model*
    ("AliciaSolid by © DWANGO Co., Ltd.") and gives **no** provenance/license for
    the `.vrma` files → unclear/over-broad relicensing. Not safe to vendor.
- `not-elm/desktop-homunculus` (Apache-2.0) — `grabbed.vrma`, `idle-maid.vrma`,
  `idle-sitting.vrma`: no per-asset provenance/credit documented → unclear. Not used.

### tk256ailab/vrm-viewer — REJECTED (README disclaims asset rights)
- MIT **code** LICENSE (Copyright 2025 TK256); ships 11 nicely-named gesture
  `.vrma` files (Angry, Blush, Clapping, **Goodbye** [waving], Jump, LookAround,
  Relax, Sad, Sleepy, Surprised, Thinking).
- Verified `Goodbye.vrma` (118,448 bytes, generator "UniGLTF-2.51.0") — a real,
  full-quality waving-goodbye VRMA.
- Rejected: the README's License section explicitly states *"This project is for
  demonstration purposes. Please ensure you have appropriate rights for any VRM
  models and animations you use."* — i.e. the author disclaims any license over
  the bundled animation assets (the MIT file covers the code only, and the
  `.vrma`/`.vrm` carry no metadata attribution). Unclear license → not used.

### Sources with no usable `.vrma`
- `vrm-c/vrm-specification` (master) — only spec schemas + a `.vrm` sample
  (`VRMC_materials_mtoon_UV_Animation_Test.vrm`); **no `.vrma`** file.
- `malaybaku/AnimationClipToVrmaSample` (MIT), `vrm-c/bvh2vrma` (MIT),
  `tk256ailab/fbx2vrma-converter`/`fbx2vrma-app` (MIT),
  `wakapippi/VRMAnimationClip` (MIT), `karthikmudunuri/VRMALL` (MIT) — converter
  tools / apps; **no committed `.vrma`** assets in tree.
- `pixiv/three-vrm` `main` branch — not used (default dev branch); only the
  `dev`-branch `test.vrma` exists.

---

*Maintained by the asset-acquisition step for the VRMA (Phase 3) AnimationMixer
clip layer. Last updated 2026-06-14.*
