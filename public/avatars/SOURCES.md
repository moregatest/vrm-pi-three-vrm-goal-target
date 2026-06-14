# VRM Avatar Sources & Licenses

This directory holds the `.vrm` avatars used by the runtime VRM-swap feature.
All models are real, permissively-licensed sample avatars suitable for local
development. Details below were verified by reading each file's bytes and its
embedded VRM metadata (the embedded meta is authoritative for the model content).

---

## `default.vrm`

- **Model name:** VRM1_Constraint_Twist_Sample (brown-haired schoolgirl-style)
- **Source URL:** https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm
  - jsDelivr mirror: https://cdn.jsdelivr.net/gh/pixiv/three-vrm@dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm
- **Repository:** https://github.com/pixiv/three-vrm (official pixiv three-vrm)
- **License:** MIT (repository), Copyright (c) pixiv Inc.
  - LICENSE: https://raw.githubusercontent.com/pixiv/three-vrm/dev/LICENSE
  - Embedded VRM 1.0 meta: avatarPermission=everyone, commercialUsage=corporation,
    creditNotation=unnecessary, allowRedistribution=true,
    modification=allowModificationRedistribution, licenseUrl=https://vrm.dev/licenses/1.0/
- **VRM version:** VRM 1.0 (extensions: VRMC_vrm specVersion=1.0, VRMC_springBone,
  VRMC_node_constraint, VRMC_materials_mtoon)
- **Size:** 10,776,032 bytes (~10.3 MB)
- **SHA-256:** `12c2b97e95e700783a6a550dc0eee2d7880aeedccef9ae67bc4c5a2f0f2631a2`

---

## `sendagaya-shino.vrm`

- **Model name:** Sendagaya Shino (VRoid Studio CC0 sample character — visually
  distinct boy/short-dark-hair model, contrasts with the default schoolgirl)
- **Source URL:** https://raw.githubusercontent.com/madjin/vrm-samples/master/vroid/beta/Sendagaya_Shino.vrm
- **Repository:** https://github.com/madjin/vrm-samples (collection of VRoid sample models)
- **License:** CC0 1.0 (Public Domain Dedication)
  - **Embedded VRM meta is explicit:** `licenseName: CC0`, `allowedUserName: Everyone`,
    `commercialUssageName: Allow`, `violentUssageName: Allow`, `sexualUssageName: Allow`.
  - CC0 deed: http://creativecommons.org/publicdomain/zero/1.0/
  - Repo README documents these VRoid samples as CC0:
    https://raw.githubusercontent.com/madjin/vrm-samples/master/README.md
  - Origin: VRoid Studio sample models (https://vroid.com / VRoid Studio).
- **VRM version:** VRM 0.x (VRM extension, specVersion "0.0", exporter VRoidStudio-0.8.1)
- **Size:** 15,074,328 bytes (~14.4 MB)
- **SHA-256:** `1e177c1a7b14f783a9c48395831db8616260d3bddd4154cb2784b779adca49b5`
- **Validity checks:** magic bytes `67 6C 54 46` ("glTF"); declared glTF length
  matches file size; VRM extension present; 3 meshes, 153 nodes, 30 textures,
  54 humanoid bones (real rigged avatar).

---

## `user-avatar.vrm`

- **Model name:** Celeste (embedded VRM 1.0 meta `name`)
- **Author(s):** JustAPal and SR (embedded VRM 1.0 meta `authors`)
- **Model version:** Final V2 (embedded VRM 1.0 meta `version`)
- **Source:** Provided by the user via Google Drive (user-supplied, not a public sample).
  - Google Drive file ID: `1EUULcYh-UwpxsJxmWc2ZykVYADplQSM_`
  - Shared link: https://drive.google.com/file/d/1EUULcYh-UwpxsJxmWc2ZykVYADplQSM_/view
  - Downloaded with `gdown` on 2026-06-14.
- **License:** Embedded VRM 1.0 meta `licenseUrl` = https://vrm.dev/licenses/1.0/
  (consult the model's embedded VRMC_vrm meta for the specific usage permissions
  before any redistribution / commercial use; this is a user-supplied model).
- **VRM version:** VRM 1.0 (extensions: VRMC_vrm specVersion=1.0, VRMC_springBone,
  VRMC_materials_mtoon, KHR_texture_transform, KHR_materials_unlit)
- **Size:** 33,063,168 bytes (~32 MB)
- **SHA-256:** `5a4cdf8a01e57062a31cd0e526d042f3c8456487a2ff580f778fc0af77d24259`
- **Validity checks:** magic bytes `67 6C 54 46` ("glTF"), glTF container version 2;
  declared glTF length (33,063,168) matches file size exactly; first chunk is JSON;
  `VRMC_vrm` extension present with specVersion 1.0. Not an HTML/permission page.

---

_Last updated: 2026-06-14_
