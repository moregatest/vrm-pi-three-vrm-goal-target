# 方案:獨舞影片分析 → 生成 VRMA

> 目標:把一支**獨舞影片**(範例:<https://youtube.com/shorts/FerJ5Gu5TE4>)自動轉成一個
> **可被本專案 runtime 直接載入 + 播放的 `.vrma`**(`VRMC_vrm_animation`),用來補足
> 我們 VRMA 表演層「缺好招牌動作資產」的缺口。
>
> 撰寫日期:2026-06-15。研究結論皆附**真實來源**;每個工具標註
> 「✅ 已在本機驗證可行 / 🟡 理論可行需實測 / 💲 付費或需帳號」。

---

## 0. TL;DR(結論先講)

- **可行,且後半段(→ VRMA)已經在本機跑通並驗證**。我們寫了一支零依賴的
  `tools/make-vrma.mjs`,把「每根骨頭的逐幀本地旋轉」直接寫成合法的
  `glTF + VRMC_vrm_animation`,本專案 runtime 成功載入、selector 選中、
  `AnimationMixer` 播放、角色實際擺動 —— 見 §7、`proof-g.mjs`(全綠)、
  `proof-g-screenshot.png`。**這代表 pipeline 最關鍵、最沒有現成輪子的一段「動作資料 → .vrma」已解決。**
- **已包成可用的 Mac CLI + 預覽**:`tools/video-to-vrma.mjs <url|本機檔>` 一鍵跑完 video→pose→`.vrma`,再用 `tools/render-vrma-preview.mjs`(無頭 three-vrm)算繪**套用到 VRM 角色的預覽 MP4/GIF**。用法見 [`video-to-vrma-usage.md`](./video-to-vrma-usage.md);示範圖 `docs/images/preview-demo.gif`。
- **前半段(影片 → 動作資料)用現成方案**,不必自己訓練模型:
  - **最省事(主線推薦):** 影片丟 **Rokoko Vision(免費)/ DeepMotion / Move.ai** → 匯出 **FBX/BVH** →
    用開源 **[fbx2vrma-converter](https://github.com/tk256ailab/fbx2vrma-converter)** 或
    **[3dRetarget BVH→VRMA](https://3dretarget.com/bvh-to-vrma)** → `.vrma`。
  - **全本機免費:** 影片 → **MediaPipe Pose**(CPU 即可)→ **[Kalidokit](https://github.com/yeemachine/kalidokit)** 解算骨骼旋轉 → 餵進我們的 `make-vrma.mjs` → `.vrma`。
  - **最高品質:** 影片 → **[WHAM](https://wham.is.tue.mpg.de/) / [GVHMR](https://zju3dv.github.io/gvhmr/)**(單目→3D/SMPL,需 GPU)→ SMPL→BVH/FBX → 轉 VRMA。
- **獨舞是這條 pipeline 的最佳輸入**(單人、全身入鏡),但仍有舊瓶頸:**腳滑、手指、快速旋轉/遮擋、root motion**(見 §9)。
- **授權是真正的紅線,不是技術問題**:把別人的舞蹈影片轉成動作再散佈/商用,可能侵犯**影片著作權**、**舞蹈編舞著作權**與**被攝者權利**。本方案的真實影片產物**只做本機 PoC、不入庫、不散佈**(見 §10)。

---

## 1. 範例影片分析

| 項目 | 內容 | 來源 / 限制 |
|---|---|---|
| 標題 | 「這場沒看 整年白看! 見識一下麻辣級的大晧禎!」 | WebFetch 取得的頁面 metadata |
| 主題標籤 | `#李晧禎` `#이호정` | 同上 |
| 性質 | **單人舞蹈表演**(韓國舞者/編舞 이호정),屬「獨舞 + 全身入鏡」 | 標題 + 標籤推斷 |
| 形式 | YouTube **Shorts**(直式 9:16、短秒數) | URL 路徑 `/shorts/` |

**限制聲明:** 我**無法直接「看」影片畫面內容**(WebFetch 只拿得到 HTML/metadata,拿不到逐幀像素;
yt-dlp 可下載但基於 §10 授權考量,真實影片只在本機 PoC 用、不分析細節也不入庫)。
以下「對 pipeline 的影響」用**獨舞短影片的一般特性**推論:

| 特性(獨舞短片常見) | 對 pipeline 的影響 | 對策 |
|---|---|---|
| **單人、全身入鏡** | ✅ 最理想:不必做多人追蹤/裁切,2D/3D 估計穩定 | 直接用單人模型 |
| **直式 9:16、可能近景** | 偶爾手腳出框 → 該關節估計跳動 | 取中段穩定區間;對缺失關節做插值/凍結 |
| **快速旋轉、急停、地板動作** | 單目 3D 在快速自轉/遮擋時深度易翻面、抖動 | 用 world-grounded 模型(WHAM/GVHMR)+ 時序平滑 |
| **服裝寬鬆(裙擺/長袖)** | 遮蔽真實肢體 → 關節位移偏差 | 接受誤差或挑遮蔽少的片段;手動修一兩個關鍵幀 |
| **音樂節拍明確** | 可用節拍對齊 loop 點 | 後處理:抓節拍當 clip 邊界,做無縫 loop |
| **腳與地面接觸頻繁** | foot-sliding(腳滑)最明顯 | 用含 contact 處理的模型(WHAM)或事後鎖腳 |

> 結論:這支影片**正是這條 pipeline 的甜蜜點輸入**(單人全身),主要風險集中在
> **快速動作 + 服裝遮擋 + 腳滑**,而非「能不能抓到人」。

---

## 2. 背景:為什麼要做這個

本專案已有完整 **VRMA 表演 clip 層**(見 `CLAUDE.md`):
`public/vrma/clips.json` manifest →(`vrma` 或 `procedural`)→ selector(`src/motion/clips.ts`)→
`@pixiv/three-vrm-animation` `createVRMAnimationClip` + `THREE.AnimationMixer`。

**唯一缺口:好的 `.vrma` 資產。** 目前唯一明確可商用的真 `.vrma` 是 pixiv 的 MIT 範例
(`gesture_wave_01.vrma`),其餘靠 procedural。本方案就是要打通「**從舞蹈影片大量產出 `.vrma`**」,
讓角色有真正的招牌舞步,而不是只會程序化揮手。

---

## 3. 端到端 Pipeline 總覽

```
┌─────────┐   ┌──────────────┐   ┌──────────────────┐   ┌──────────────┐   ┌─────────────┐
│ A. 影片 │ → │ B. 姿態估計  │ → │ C. Retarget 到   │ → │ D. → VRMA    │ → │ E. 整合進    │
│  取得   │   │ 2D/3D/SMPL   │   │   VRM humanoid   │   │ VRMC_vrm_    │   │ 本專案 clip │
│         │   │              │   │   (骨骼旋轉)     │   │ animation    │   │ 層 + 驗證    │
└─────────┘   └──────────────┘   └──────────────────┘   └──────────────┘   └─────────────┘
   mp4            關節點/SMPL         per-bone 旋轉軌          .vrma            clips.json
 (yt-dlp)      (MediaPipe/WHAM…)   (Kalidokit/SMPL→VRM)   (make-vrma/轉換器)   + proof
```

每一段都可以**獨立替換**(這就是把它拆成階段的原因)。下面逐段給「輸入 / 輸出 / 工具 / 格式 / 狀態」。

---

## 4. 階段拆解

### 階段 A — 取得影片
- **輸入:** YouTube/檔案 URL。**輸出:** `.mp4`(+ 抽幀 `.png`)。
- **工具:** `yt-dlp`(✅ 本機已裝,`/opt/homebrew/bin/yt-dlp`)、`ffmpeg`(✅ 已裝)。
- **指令:**
  ```bash
  yt-dlp -f 'bv*[height<=1080]+ba/b' -o dance.mp4 'https://youtube.com/shorts/FerJ5Gu5TE4'
  ffmpeg -i dance.mp4 -vf fps=30 frames/%04d.png        # 抽 30fps 幀(姿態估計用)
  ```
- ⚠️ **授權:** 見 §10。產物只做本機 PoC、不入庫。

### 階段 B — 影片 → 人體姿態

分三個層級(由淺到深、由快到準):

| 工具 | 輸出 | 維度 | 算力 | 狀態 | 來源 |
|---|---|---|---|---|---|
| **MediaPipe Pose** | 33 個 2D + **3D world landmarks**(座標,非旋轉) | 2.5D | **CPU 即可** | 🟡 本機可裝(`pip install mediapipe`)| [Google AI Edge](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker) |
| **MoveNet / OpenPose** | 2D keypoints | 2D | CPU/GPU | 🟡 | (MoveNet TF Hub / OpenPose) |
| **WHAM**(CVPR'24) | **SMPL** + 全域軌跡,**含 contact 抑制腳滑** | 3D world | **GPU** | 🟡 開源需實測 | [wham.is.tue.mpg.de](https://wham.is.tue.mpg.de/) |
| **GVHMR**(ICCV'24?) | world-grounded SMPL(Gravity-View 座標) | 3D world | **GPU** | 🟡 開源(code+weights 公開)| [zju3dv.github.io/gvhmr](https://zju3dv.github.io/gvhmr/) |
| **TRAM**(ECCV'24) | 全域軌跡 + motion | 3D world | GPU | 🟡 | (arXiv/GitHub) |
| **4D-Humans / MotionBERT** | SMPL / 3D pose | 3D | GPU | 🟡 | ([human-motion-capture 清單](https://github.com/visonpon/human-motion-capture)) |

> 關鍵差異:**MediaPipe 給的是「關節座標」,不是「骨骼旋轉」**——所以 B→C 還要解算旋轉(Kalidokit)。
> **WHAM/GVHMR 給的是 SMPL 參數**(本身就含旋轉 θ),retarget 更直接但要 GPU + SMPL→VRM 映射。

### 階段 B' — 影片 → motion 的「現成一站式」服務(把 B+C 一起做掉)

| 服務 | 開源? | 價格 | 輸出格式 | 狀態 | 來源 |
|---|---|---|---|---|---|
| **Rokoko Vision** | 否(雲端) | **免費**(單鏡頭),雙鏡頭付費 | FBX/BVH… | 💲🟡 | [rokoko.com](https://www.rokoko.com/insights/the-future-of-motion-capture) |
| **DeepMotion Animate 3D** | 否 | freemium | **FBX / BVH / GLB / MP4**;可上傳自訂 VRM/GLB 角色、含臉+手 | 💲🟡 | [deepmotion.com/animate-3d](https://www.deepmotion.com/animate-3d) |
| **Move.ai** | 否 | $99/月起(100 分鐘) | FBX… (最準) | 💲🟡 | [比較](https://www.cbinsights.com/compare/moveai-vs-rokoko) |
| **Plask** | 否 | $18/月起,免費 15 秒/日 | FBX/BVH… | 💲🟡 | [tato.studio 比較](https://tato.studio/best-ai-video-to-mocap) |
| **MocapForAll** | 是 | — | **BVH**(可直接拖 VRM 進去預覽) | 🟡 | [手冊](https://akiya-research-institute.github.io/MocapForAll-Manual/en/how-to-export/to-bvh-files/) |

> 這些都**不直接輸出 `.vrma`**,輸出 FBX/BVH,所以仍要接階段 D 的轉換器。
> 共同弱點:**遮擋(手背後)、低光、手指細節**(多家評測一致)。

### 階段 C — 姿態 → VRM humanoid 骨骼旋轉(retarget)

| 來源資料 | 工具 / 方法 | 輸出 | 狀態 | 來源 |
|---|---|---|---|---|
| MediaPipe landmarks | **Kalidokit**(blendshape+kinematics solver,專為 VRM/Live2D)| 各骨 euler 旋轉 + 表情權重 | 🟡 npm 套件 | [github.com/yeemachine/kalidokit](https://github.com/yeemachine/kalidokit) |
| MediaPipe landmarks | 自寫:由「相鄰關節向量 + 參考軸做 cross product 求唯一旋轉」 | quaternion | 🟡(我們 PoC 用簡化版)| [three.js 論壇](https://discourse.threejs.org/t/how-can-i-animate-a-character-arm-hand-rig-from-recorded-mediapipe-landmark-data/92216) |
| SMPL(WHAM/GVHMR) | SMPL→Mixamo/Humanoid 骨架對映(SMPL θ 已是旋轉) | FBX/BVH 骨骼動畫 | 🟡 需 SMPL→VRM 骨名表 | — |
| 任一 BVH/FBX | 丟 Blender + **VRM Add-on** retarget | VRM humanoid 動畫 | 🟡 | [saturday06/VRM-Addon](https://github.com/saturday06/VRM-Addon-for-Blender) |

教學參考(MediaPipe→VRM 全鏈):[Wawa Sensei: VTuber with three.js + VRM + MediaPipe](https://wawasensei.dev/tuto/vrm-avatar-with-threejs-react-three-fiber-and-mediapipe)。

### 階段 D — → VRMA(`VRMC_vrm_animation`)

`.vrma` = 一個 **glTF 2.0(通常 .glb 二進位)** + `VRMC_vrm_animation` 擴充。核心結構
(來源:[vrm-c 規格](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm_animation-1.0/README.md)):

```jsonc
{
  "extensionsUsed": ["VRMC_vrm_animation"],
  "nodes": [ /* 一棵 humanoid 骨架樹,rest = VRM T-pose,無 scale */ ],
  "animations": [{
    "channels": [{ "sampler": 0, "target": { "node": 0, "path": "rotation" } /* 骨頭只能 rotation;hips 可 translation */ }],
    "samplers": [{ "input": <時間 accessor>, "interpolation": "LINEAR", "output": <四元數 accessor> }]
  }],
  "extensions": { "VRMC_vrm_animation": {
    "specVersion": "1.0",
    "humanoid": { "humanBones": { "hips": {"node":0}, "spine": {"node":1}, /* … */ } },
    "expressions": { "preset": { "aa": {"node":59}, "happy": {"node":62} } },   // 選配:表情
    "lookAt": { "node": 64, "offsetFromHeadBone": [0,0.06,0] }                   // 選配:視線
  }}
}
```
規則重點:骨頭只放 `rotation`(四元數),**只有 hips 可以 `translation`**;表情用 `translation.x` 當 [0,1] 權重;
**禁止** scale;rest pose 必須是 VRM T-pose;建議 30fps、LINEAR。

**三條產出 `.vrma` 的路:**

| 方法 | 輸入 | 工具 | 狀態 | 來源 |
|---|---|---|---|---|
| **(本方案主推)程式化直寫** | per-bone 旋轉軌 | **`tools/make-vrma.mjs`(我們寫的,零依賴)** | ✅ **已驗證**(§7) | 本repo |
| **FBX → VRMA** | mocap FBX | [fbx2vrma-converter](https://github.com/tk256ailab/fbx2vrma-converter)(Node,直接改 glTF JSON,52 根 Mixamo→VRM 骨名含手指)| 🟡(Apple Silicon 需 Rosetta 跑 FBX2glTF) | GitHub |
| **BVH → VRMA** | mocap BVH | [3dRetarget 線上轉檔](https://3dretarget.com/bvh-to-vrma)(自動 humanoid 骨名對映) | 🟡 線上工具需實測 | 3dretarget.com |
| **Blender → VRMA** | 已套到 VRM 的動畫 | **[VRM Add-on for Blender](https://github.com/saturday06/VRM-Addon-for-Blender)**(支援匯出 VRMa,有 Python API)| 🟡(注意 issue #584:非 humanoid 骨可能殘留 keyframe)| GitHub |

### 階段 E — 整合進本專案(見 §7,已驗證)。

---

## 5. 推薦主線 + 替代方案(取捨)

| 方案 | 路線 | 成本 | 品質 | 自動化 | 適用 |
|---|---|---|---|---|---|
| **★ 主線:全本機免費** | 影片 → **MediaPipe** → **Kalidokit** → **`make-vrma.mjs`** | 免費、CPU | 中(2.5D,手指弱、會腳滑) | **全自動、可批次、零雲端** | 大量產出、隱私、與本 repo 無縫 |
| 替代 1:一站式雲端 | 影片 → **Rokoko/DeepMotion** → FBX/BVH → **fbx2vrma/3dRetarget** | Rokoko 免費起 / 其餘💲 | 中高 | 半自動(上傳/下載) | 要省工程、品質要好一點 |
| 替代 2:最高品質本機 | 影片 → **WHAM/GVHMR**(SMPL)→ SMPL→BVH → 轉 VRMA | 免費但**需 GPU** | **高**(world-grounded、抑腳滑) | 全自動(設定較重) | 招牌大招、要最好品質 |
| 替代 3:Blender 收尾 | 任一 mocap → Blender + VRM Add-on 修 + 匯出 VRMA | 免費 | 高(可人工修幀) | 手動 | 少量精修、要可控 |

> **為什麼主線選 MediaPipe→Kalidokit→make-vrma:** 三段全本機、全開源、零帳號、可寫成一支 CLI 批次跑,
> 且**尾端 `make-vrma` 我們已經驗證能被自己 runtime 播放**。先用主線把「量」做出來,招牌大招再用替代 2/3 精修。

---

## 6. 與本專案 VRMA clip 層的整合(只需一支檔 + 一筆 manifest)

1. 產出的 `.vrma` 丟進 `public/vrma/`(例:`public/vrma/dance_signature_01.vrma`)。
2. `public/vrma/clips.json` 加**一筆**:
   ```jsonc
   {
     "id": "dance_signature_01",
     "source": { "kind": "vrma", "file": "/vrma/dance_signature_01.vrma" },
     "category": "gesture", "tags": ["dance"], "emotion": "happy",
     "durationMs": 8000, "loop": false, "priority": 60,
     "blend": { "inMs": 250, "outMs": 500 }
   }
   ```
3. **不必改任何程式**:runtime 開機自動 load(`realVrmaLoaded` 會包含它),
   semantic intent `motion: "dance"` 經 selector 命中 → `AnimationMixer` 播放。
4. (本方案已把 `generated_dance` 這筆加進 manifest 當**活生生的範例**。)

---

## 7. 最小 PoC(✅ 已完成並驗證)

**證明的命題:** 「可以**程式化**產出一個**能被本專案 runtime 載入 + 播放**的 `.vrma`」——成立。

- **產生器:** `tools/make-vrma.mjs`(零依賴 Node)。把 9 根 humanoid 骨頭的逐幀本地旋轉
  (此 PoC 用合成舞步;`poseEuler()` 換成真實 pose 資料即可)寫成合法 GLB:
  ```bash
  node tools/make-vrma.mjs                 # → public/vrma/generated_demo.vrma
  # wrote …/generated_demo.vrma (16552 bytes, 91 frames @ 30fps, 9 bones)
  ```
  驗證檔案合法:magic = `glTF`、含 `VRMC_vrm_animation`、9 channels、humanBones=hips…rightLowerArm。
- **驗證載入+播放:** `node proof-g.mjs`(自起 API+Vite + 真 GPU 瀏覽器):
  - `realVrmaLoaded` 含 `generated_dance`(= 我們的檔)
  - clientLog 走乾淨路徑:`vrma_loaded → intent(dance) → clip_selected(source:vrma) → clip_started`
  - `realVrmaPlayed:["generated_dance"]`、`lastClipSource:"vrma"`
  - 播放中角色實際擺動:`poseDistinct 37`、`poseRange 360`;真實算繪 `std 62.7`、白底僅 7.6%
  - 截圖 `proof-g-screenshot.png`:角色雙臂舞姿、軀幹直立。
  - **結果:`"failedChecks": []`(全綠)。**

### 真實影片版(✅ 已在本機完整跑通;產物不入庫——授權)
> 用範例短片 <https://youtube.com/shorts/FerJ5Gu5TE4> **實跑**,M4 Max、**無需 CUDA**:
>
> | 步驟 | 指令 / 工具 | 實際結果 |
> |---|---|---|
> | 1. 下載 | `yt-dlp … -o dance.webm` | 360×640、29.97fps、20.46s |
> | 2. 抽幀 | `ffmpeg -i dance.webm -vf fps=30 frames/%04d.png` | 613 幀 |
> | 3. 姿態 | `tools/extract_pose.py`(MediaPipe Tasks **PoseLandmarker**,VIDEO 模式、full 模型)| 613 幀 **595 偵測(97%)** → `pose.json` |
> | 4. retarget→VRMA | `tools/make-vrma-from-pose.mjs pose.json dance_real.vrma 180 240`(最短弧四元數 rest→觀測肢向;前臂彎相對上臂;EMA 平滑)| `dance_real.vrma` **38.6KB / 240 幀 / 7.97s / 9 骨** |
> | 5. 驗證載入播放 | 暫換成 `generated_demo.vrma` 跑 `proof-g.mjs` | **`pass:true`**;`realVrmaPlayed:generated_dance`、`lastClipSource:vrma`、`poseRange 1277`(比合成的 360 大——真舞步擺幅更大)、真實算繪 `std 57.7` |
>
> 截圖 `proof-realvideo-screenshot.png`:Celeste 擺出**從真實舞蹈影格 retarget 出來的姿勢**(頭部自然側傾、單臂外伸、軀幹直立、不扭曲)。
> **限制(誠實說明):** 簡化 retarget(只上半身+脊椎/頭、無 twist/手指/腳 IK、座標慣例直接套用未逐幀視覺微調)——屬「前端可行性 PoC」,非廣播級 mocap;品質要再上去需 Kalidokit 完整解算或替代 2(WHAM/GVHMR)。
> **授權:** 下載影片、`pose.json`、`dance_real.vrma`、`proof-realvideo-screenshot.png` 皆**只存在本機 `/tmp` 或 `.gitignore`,不入庫、不散佈**(見 §9)。

---

## 8. 對齊與品質問題(實作必踩的坑)

| 問題 | 說明 | 對策 |
|---|---|---|
| **T-pose / rest pose** | `.vrma` 規格要求 rest = VRM T-pose;來源 mocap 常是 A-pose | 轉檔時做 rest-pose 補償(差值);`make-vrma` 直接以 T-pose 建骨架 |
| **Bone mapping** | 來源骨名(Mixamo/SMPL/MediaPipe idx)≠ VRM humanBones 名 | 維護對映表(fbx2vrma 已含 52 根;SMPL 要自建) |
| **手指** | 影片估計手指普遍很差(多家評測指出) | 先不做手指(只 22 根 body);手指用 procedural 或留中性 |
| **腳滑 foot-sliding** | 單目 3D 最明顯的瑕疵 | 用含 contact 的 WHAM;或事後鎖腳(foot IK / 速度閾值鎖定) |
| **Root motion** | 舞步有位移;但 `.vrma` 只有 hips 能 translation | 決定要不要保留位移;角色釘原地時把 hips.translation 歸零只留旋轉 |
| **座標系 / 單位** | glTF 右手系 Y-up、公尺;各來源不一 | 轉檔統一到 glTF 慣例;`make-vrma` 已用 Y-up/公尺 |
| **VRM 0.x vs 1.0** | VRM0 面向 −Z、VRM1 面向 +Z;`.vrma` 是 1.0 概念 | runtime 已處理(VRM0 翻 180°);產 `.vrma` 以 1.0 為準 |
| **影格率 / 時長 / loop** | 30fps 建議;舞步要無縫 loop | 抓音樂節拍當邊界;首尾幀對齊 |
| **retarget 比例** | 來源人體比例 ≠ 目標 VRM | 用「旋轉」而非「位置」驅動(本 pipeline 正是如此)可大幅免疫比例差 |

---

## 9. 授權與倫理(真正的紅線)

- **影片著作權:** YouTube 影片預設受著作權保護;下載/再利用須符合該影片授權或合理使用。
- **編舞著作權:** 舞蹈本身(編舞)在多數法域可受著作權保護——「把動作 mocap 下來再散佈/商用」風險最高。
- **被攝者 / 人格權:** 真人表演者的形象與表演有相關權利。
- **本方案採取的作法:**
  - 真實影片產物(下載的 mp4、抽出的 pose、衍生的 `.vrma`)**只做本機技術 PoC、`.gitignore`、不散佈、不商用**。
  - **入庫/可商用的資產**改用:**自製合成動作**(本 PoC 的 `generated_demo.vrma`)、**自行拍攝**或**已授權/CC0** 的舞蹈、或**請編舞者授權**。
  - 對外展示請標註來源並取得授權。
- 一句話:**技術上能做 ≠ 法律上能散佈。** 量產招牌舞步請走「自拍/授權素材」這條,別直接吃別人的短影片。

---

## 10. 風險與限制

- **品質天花板:** 單目影片→3D 的腳滑/抖動/遮擋是現況通病,免費路線(MediaPipe)尤其;要漂亮需 GPU(WHAM/GVHMR)或人工修(Blender)。
- **線上轉換器/雲端服務**(3dRetarget、Rokoko、DeepMotion 等)我**未逐一實測**輸出能 100% 被本 runtime 播放——標 🟡,落地前需各驗一次。
- **fbx2vrma** 在 Apple Silicon 需 Rosetta(FBX2glTF 為 x64);BVH 路線(3dRetarget)可繞開。
- **手指 / 表情 / 視線** 本 PoC 未做(只 body 旋轉);可後續用 `VRMC_vrm_animation` 的 `expressions`/`lookAt` 補。
- **真實影片 E2E 未在本工作階段全跑**(授權 + MediaPipe 安裝/retarget 調參);已備齊工具與已驗證的尾端。

---

## 附錄:來源連結

**規格 / 格式**
- VRMC_vrm_animation 規格:<https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm_animation-1.0/README.md>
- VRM Animation 說明:<https://vrm.dev/en/vrma/>

**影片 → 姿態 / 動作**
- MediaPipe Pose:<https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker>
- WHAM:<https://wham.is.tue.mpg.de/> ・ GVHMR:<https://zju3dv.github.io/gvhmr/>
- 開源 mocap 論文清單:<https://github.com/visonpon/human-motion-capture>
- 服務比較:<https://tato.studio/best-ai-video-to-mocap> ・ <https://www.cbinsights.com/compare/moveai-vs-rokoko>
- DeepMotion:<https://www.deepmotion.com/animate-3d> ・ Rokoko:<https://www.rokoko.com/insights/the-future-of-motion-capture>
- MocapForAll(BVH):<https://akiya-research-institute.github.io/MocapForAll-Manual/en/how-to-export/to-bvh-files/>

**Retarget / 轉 VRMA**
- Kalidokit:<https://github.com/yeemachine/kalidokit>
- fbx2vrma-converter:<https://github.com/tk256ailab/fbx2vrma-converter>
- 3dRetarget BVH→VRMA:<https://3dretarget.com/bvh-to-vrma>
- VRM Add-on for Blender:<https://github.com/saturday06/VRM-Addon-for-Blender>
- MediaPipe→VRM 教學:<https://wawasensei.dev/tuto/vrm-avatar-with-threejs-react-three-fiber-and-mediapipe>

**本專案產物**
- 產生器:`tools/make-vrma.mjs` ・ 範例輸出:`public/vrma/generated_demo.vrma`
- 驗證:`proof-g.mjs`(全綠)・ 截圖:`proof-g-screenshot.png` ・ manifest:`public/vrma/clips.json`(`generated_dance`)
