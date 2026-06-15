"""extract_pose.py — MediaPipe Pose (+ Hands) over a folder of frames → JSON for the
retarget engines (make-vrma-kalidokit.mjs / make-vrma-from-pose.mjs).

Usage:
  python tools/extract_pose.py <frames_dir> <out.json> [--start N] [--end N] [--no-hands]

Needs:  pip install mediapipe   (CPU is fine; macOS/Apple Silicon OK, no CUDA)
Models auto-download to ~/.cache/vrma-mocap/ on first run.
"""
import glob, json, os, sys, urllib.request
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

POSE_URL = ("https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
            "pose_landmarker_full/float16/latest/pose_landmarker_full.task")
HAND_URL = ("https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
            "hand_landmarker/float16/latest/hand_landmarker.task")


def get_model(url, fname):
    cache = os.path.expanduser("~/.cache/vrma-mocap")
    os.makedirs(cache, exist_ok=True)
    dest = os.path.join(cache, fname)
    if not os.path.exists(dest):
        sys.stderr.write(f"[extract_pose] downloading {fname}\n")
        urllib.request.urlretrieve(url, dest)
    return dest


def main():
    if len(sys.argv) < 3:
        sys.stderr.write(__doc__)
        sys.exit(2)
    frames_dir, out_json = sys.argv[1], sys.argv[2]
    start, end, do_hands = 0, None, True
    a = sys.argv[3:]
    for i, k in enumerate(a):
        if k == "--start":
            start = int(a[i + 1])
        elif k == "--end":
            end = int(a[i + 1])
        elif k == "--no-hands":
            do_hands = False

    frames = sorted(glob.glob(os.path.join(frames_dir, "*.png")) + glob.glob(os.path.join(frames_dir, "*.jpg")))
    if end is None:
        end = len(frames)
    frames = frames[start:end]
    if not frames:
        sys.stderr.write("[extract_pose] no frames found in %s\n" % frames_dir)
        sys.exit(1)

    pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
        base_options=python.BaseOptions(model_asset_path=get_model(POSE_URL, "pose_landmarker_full.task")),
        running_mode=vision.RunningMode.VIDEO, num_poses=1))
    hl = None
    if do_hands:
        hl = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
            base_options=python.BaseOptions(model_asset_path=get_model(HAND_URL, "hand_landmarker.task")),
            running_mode=vision.RunningMode.VIDEO, num_hands=2))

    out, out2d, hands = [], [], []
    last, last2d, lasth, det, hdet = None, None, {"left": None, "right": None}, 0, 0
    for i, f in enumerate(frames):
        img = mp.Image.create_from_file(f)
        ts = int((start + i) * 1000 / 30)
        res = pose.detect_for_video(img, ts)
        if res.pose_world_landmarks:
            last = [[round(p.x, 4), round(p.y, 4), round(p.z, 4), round(getattr(p, "visibility", 1.0), 3)]
                    for p in res.pose_world_landmarks[0]]
            if res.pose_landmarks:
                last2d = [[round(p.x, 4), round(p.y, 4), round(p.z, 4), round(getattr(p, "visibility", 1.0), 3)]
                          for p in res.pose_landmarks[0]]
            det += 1
        out.append(last if last is not None else [[0, 0, 0, 0]] * 33)
        out2d.append(last2d if last2d is not None else [[0, 0, 0, 0]] * 33)

        if hl:
            hres = hl.detect_for_video(img, ts)
            cur = {"left": None, "right": None}
            if hres.hand_landmarks:
                for hi, hlms in enumerate(hres.hand_landmarks):
                    side = hres.handedness[hi][0].category_name.lower() if hres.handedness else None
                    if side in ("left", "right"):
                        cur[side] = [[round(p.x, 4), round(p.y, 4), round(p.z, 4)] for p in hlms]
            if cur["left"] or cur["right"]:
                hdet += 1
                lasth = cur
            hands.append(cur if (cur["left"] or cur["right"]) else lasth)

    data = {"fps": 30, "start": start, "frames": len(out), "detected": det, "landmarks": out, "landmarks2d": out2d}
    if hl:
        data["hands"] = hands
        data["handsDetected"] = hdet
    json.dump(data, open(out_json, "w"))
    print(json.dumps({"frames": len(out), "detected": det, "handsDetected": hdet if hl else 0, "out": out_json}))


if __name__ == "__main__":
    main()
