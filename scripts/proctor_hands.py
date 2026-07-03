"""Proctoring de MÃOS + ENQUADRAMENTO (pós-prova) com MediaPipe.

Lê o vídeo gravado, amostra ~1 frame a cada N segundos e reporta:
- MÃOS: presença + o maior trecho de AUSÊNCIA SUSTENTADA (mão fora do quadro).
- ENQUADRAMENTO: se a CABEÇA (nariz, dentro do quadro, com folga no topo) e os
  OMBROS (tronco) aparecem — sinaliza quando o aluno fica mal enquadrado (perto
  demais/cabeça cortada ou fora do quadro) por um trecho sustentado.

Saída: JSON no stdout com {"hands": {...}, "framing": {...}}. Sinais para revisão
humana, NUNCA acusação. Tudo local — o vídeo não sai da infra. Invocado por
lib/proctor.js (child_process). Uso: python proctor_hands.py <video>
"""
import sys, json, os, glob, tempfile, shutil, subprocess
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

INTERVAL = 1.5          # amostragem DENSA: misses breves não viram "ausência longa" falsa
CONF = 0.08             # limiar baixo p/ mãos: punho fechado/dedos entrelaçados ainda contam
ABSENCE_FLAG_SEC = 12   # mãos fora do quadro por trecho contíguo >= isto → sinaliza
HANDS_MIN_PCT = 95      # mãos presentes abaixo disto (% do tempo) → sinaliza
FRAMING_FLAG_SEC = 12   # mal enquadrado por trecho contíguo >= isto → sinaliza
_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
HAND_MODEL = os.path.join(_ROOT, "models", "hand_landmarker.task")
# O modelo de pose fica junto do gate do navegador (static/vision), não em models/.
POSE_MODEL = os.path.join(_ROOT, "static", "vision", "models", "pose_landmarker_lite.task")


def _longest_run(flags):
    """Maior sequência contígua de True (em nº de amostras)."""
    longest = cur = 0
    for f in flags:
        cur = cur + 1 if f else 0
        longest = max(longest, cur)
    return longest


def _well_framed(pose_landmarks):
    """Cabeça (nariz dentro do quadro, com folga no topo p/ a testa) + ombros visíveis.
    Espelha o gate de SETUP do navegador (nariz+olhos dentro do quadro, ombros)."""
    if not pose_landmarks:
        return False
    lm = pose_landmarks[0]
    def vis(i):
        v = lm[i].visibility
        return 1.0 if v is None else v
    def inframe(i):
        return 0.03 < lm[i].x < 0.97 and 0.05 < lm[i].y < 0.98
    head = vis(0) > 0.6 and vis(2) > 0.5 and vis(5) > 0.5 and inframe(0) and lm[0].y > 0.08
    shoulders = vis(11) > 0.5 and vis(12) > 0.5
    return bool(head and shoulders)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing video path"})); return
    hand_det = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
        base_options=python.BaseOptions(model_asset_path=HAND_MODEL),
        num_hands=2, min_hand_detection_confidence=CONF, min_hand_presence_confidence=CONF,
        running_mode=vision.RunningMode.IMAGE))
    pose_det = None
    try:
        pose_det = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
            base_options=python.BaseOptions(model_asset_path=POSE_MODEL),
            num_poses=1, min_pose_detection_confidence=0.5,
            running_mode=vision.RunningMode.IMAGE))
    except Exception as e:
        sys.stderr.write(f"pose init falhou (enquadramento desativado): {e}\n")
        pose_det = None  # sem pose → sem enquadramento; mãos seguem

    # Extrai frames via ffmpeg (decodifica webm de forma robusta — o
    # cv2.VideoCapture truncava alguns webm da MediaRecorder, lendo poucos frames).
    tmp = tempfile.mkdtemp(prefix="oralproc_")
    hands_present = []   # [(sec, bool)]
    framed = []          # [(sec, bool)]  — só quando pose disponível
    try:
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", sys.argv[1],
             "-vf", f"fps=1/{INTERVAL}", os.path.join(tmp, "f_%04d.jpg")],
            check=True)
        frames = sorted(glob.glob(os.path.join(tmp, "*.jpg")))
        for i, p in enumerate(frames):
            sec = int(round(i * INTERVAL))
            img = mp.Image.create_from_file(p)
            hres = hand_det.detect(img)
            hands_present.append((sec, bool(hres.hand_landmarks)))
            if pose_det is not None:
                pres = pose_det.detect(img)
                framed.append((sec, _well_framed(pres.pose_landmarks)))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    total = len(hands_present) or 1
    absent_secs = [t for (t, p) in hands_present if not p]
    max_absence_sec = _longest_run([not p for (_, p) in hands_present]) * INTERVAL
    present_pct = round(sum(1 for (_, p) in hands_present if p) / total * 100)
    out = {
        "hands": {
            "frames": len(hands_present),
            "interval_sec": INTERVAL,
            "present_pct": present_pct,
            "absent_pct": round(len(absent_secs) / total * 100),
            "max_absence_sec": max_absence_sec,
            # sinaliza se as mãos ficaram fora por um trecho longo OU se a presença
            # total ficou abaixo do mínimo (ex.: 84% < 95%).
            "flag": max_absence_sec >= ABSENCE_FLAG_SEC or present_pct < HANDS_MIN_PCT,
            "at": absent_secs[:8],
        },
        "model": "mediapipe hand_landmarker (local)",
    }
    if framed:
        bad_secs = [t for (t, ok) in framed if not ok]
        ftotal = len(framed) or 1
        max_bad_sec = _longest_run([not ok for (_, ok) in framed]) * INTERVAL
        out["framing"] = {
            "well_pct": round(sum(1 for (_, ok) in framed if ok) / ftotal * 100),
            "bad_pct": round(len(bad_secs) / ftotal * 100),
            "max_bad_sec": max_bad_sec,
            "flag": max_bad_sec >= FRAMING_FLAG_SEC,
            "at": bad_secs[:8],
        }
        out["model"] += " + pose_landmarker (enquadramento)"
    print(json.dumps(out))


main()
