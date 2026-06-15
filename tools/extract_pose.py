"""extract_pose.py — run MediaPipe Pose (Tasks API, VIDEO mode) over a folder of
frames and dump per-frame 3D world landmarks to JSON for make-vrma-from-pose.mjs.

Usage:
  python tools/extract_pose.py <frames_dir> <out.json> [--start N] [--end N] [--model PATH]

Needs:  pip install mediapipe   (CPU is fine; macOS/Apple Silicon OK, no CUDA)
The pose model is auto-downloaded to ~/.cache/vrma-mocap/ on first run.
"""
import glob, json, os, sys, urllib.request
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

MODEL_URL = ("https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
             "pose_landmarker_full/float16/latest/pose_landmarker_full.task")


def get_model(path):
    if path and os.path.exists(path):
        return path
    cache = os.path.expanduser("~/.cache/vrma-mocap")
    os.makedirs(cache, exist_ok=True)
    dest = path or os.path.join(cache, "pose_landmarker_full.task")
    if not os.path.exists(dest):
        sys.stderr.write(f"[extract_pose] downloading pose model -> {dest}\n")
        urllib.request.urlretrieve(MODEL_URL, dest)
    return dest


def main():
    if len(sys.argv) < 3:
        sys.stderr.write(__doc__)
        sys.exit(2)
    frames_dir, out_json = sys.argv[1], sys.argv[2]
    start, end, model = 0, None, None
    a = sys.argv[3:]
    for i, k in enumerate(a):
        if k == "--start":
            start = int(a[i + 1])
        elif k == "--end":
            end = int(a[i + 1])
        elif k == "--model":
            model = a[i + 1]

    frames = sorted(glob.glob(os.path.join(frames_dir, "*.png")) + glob.glob(os.path.join(frames_dir, "*.jpg")))
    if end is None:
        end = len(frames)
    frames = frames[start:end]
    if not frames:
        sys.stderr.write("[extract_pose] no frames found in %s\n" % frames_dir)
        sys.exit(1)

    opts = vision.PoseLandmarkerOptions(
        base_options=python.BaseOptions(model_asset_path=get_model(model)),
        running_mode=vision.RunningMode.VIDEO, num_poses=1)
    out, last, det = [], None, 0
    with vision.PoseLandmarker.create_from_options(opts) as lm:
        for i, f in enumerate(frames):
            img = mp.Image.create_from_file(f)
            res = lm.detect_for_video(img, int((start + i) * 1000 / 30))
            if res.pose_world_landmarks:
                last = [[round(p.x, 4), round(p.y, 4), round(p.z, 4), round(getattr(p, "visibility", 1.0), 3)]
                        for p in res.pose_world_landmarks[0]]
                det += 1
            out.append(last if last is not None else [[0, 0, 0, 0]] * 33)
    json.dump({"fps": 30, "start": start, "frames": len(out), "detected": det, "landmarks": out}, open(out_json, "w"))
    print(json.dumps({"frames": len(out), "detected": det, "out": out_json}))


if __name__ == "__main__":
    main()
