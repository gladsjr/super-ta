"""Proctoring de MÃOS (pós-prova) com MediaPipe Hands.

Lê o vídeo gravado, amostra ~1 frame a cada N segundos, conta mãos por frame e
reporta a PRESENÇA de mãos + o maior trecho de AUSÊNCIA SUSTENTADA. Saída: JSON
no stdout. Sinal para revisão humana, NUNCA acusação. Tudo local — o vídeo não
sai da infra. Invocado por lib/proctor.js (child_process).

Uso: python proctor_hands.py <video>
"""
import sys, json, os, glob, tempfile, shutil, subprocess
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

INTERVAL = 1.5          # amostragem DENSA: misses breves de detecção não viram
                        # "ausência longa" falsa (entre misses a mão reaparece)
CONF = 0.08            # limiar baixo: punho fechado/dedos entrelaçados ainda contam
ABSENCE_FLAG_SEC = 12  # ausência CONTÍGUA >= isto → sinaliza (mão fora do quadro)
MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models", "hand_landmarker.task")


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing video path"})); return
    det = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
        base_options=python.BaseOptions(model_asset_path=MODEL),
        num_hands=2, min_hand_detection_confidence=CONF, min_hand_presence_confidence=CONF,
        running_mode=vision.RunningMode.IMAGE))
    # Extrai frames via ffmpeg (decodifica webm de forma robusta — o
    # cv2.VideoCapture truncava alguns webm da MediaRecorder, lendo poucos frames).
    tmp = tempfile.mkdtemp(prefix="oralhands_")
    present = []
    try:
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", sys.argv[1],
             "-vf", f"fps=1/{INTERVAL}", os.path.join(tmp, "f_%04d.jpg")],
            check=True)
        frames = sorted(glob.glob(os.path.join(tmp, "*.jpg")))
        for i, p in enumerate(frames):
            res = det.detect(mp.Image.create_from_file(p))
            present.append((int(round(i * INTERVAL)), bool(res.hand_landmarks)))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    total = len(present) or 1
    absent_secs = [t for (t, p) in present if not p]
    longest = cur = 0
    for (_, p) in present:
        cur = 0 if p else cur + 1
        longest = max(longest, cur)
    max_absence_sec = longest * INTERVAL
    print(json.dumps({
        "frames": len(present),
        "interval_sec": INTERVAL,
        "present_pct": round(sum(1 for (_, p) in present if p) / total * 100),
        "absent_pct": round(len(absent_secs) / total * 100),
        "max_absence_sec": max_absence_sec,
        "flag": max_absence_sec >= ABSENCE_FLAG_SEC,
        "at": absent_secs[:8],
        "model": "mediapipe hand_landmarker (local)",
    }))


main()
