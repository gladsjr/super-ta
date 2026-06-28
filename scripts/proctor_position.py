"""Portão de SETUP da prova oral: avalia UMA imagem (frame da câmera) contra a
posição canônica — rosto+ombros enquadrados, distância (~1,5 m via largura de
ombros), centralizado e mãos à mostra. Pose + Hands (MediaPipe). Local.

Saída JSON no stdout: { ok, checks{...}, guidance }. Uso: python proctor_position.py <img>
"""
import sys, json, os
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

MODELS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models")
SW_MIN, SW_MAX = 0.28, 0.62  # largura de ombros (proxy de distância): faixa boa
CX_TOL = 0.18                # tolerância de centralização (|centro_x - 0.5|)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "guidance": "sem imagem", "error": "missing image"})); return
    pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
        base_options=python.BaseOptions(model_asset_path=os.path.join(MODELS, "pose_landmarker.task")),
        running_mode=vision.RunningMode.IMAGE, num_poses=1, min_pose_detection_confidence=0.5))
    hands = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
        base_options=python.BaseOptions(model_asset_path=os.path.join(MODELS, "hand_landmarker.task")),
        num_hands=2, min_hand_detection_confidence=0.08, running_mode=vision.RunningMode.IMAGE))
    img = mp.Image.create_from_file(sys.argv[1])
    pr = pose.detect(img)
    hr = hands.detect(img)
    nh = len(hr.hand_landmarks) if hr.hand_landmarks else 0

    if not pr.pose_landmarks:
        print(json.dumps({"ok": False, "checks": {"face": False, "shoulders": False}, "guidance": "Apareça na câmera, de frente."}))
        return
    L = pr.pose_landmarks[0]
    face = L[0].visibility > 0.5
    shoulders = L[11].visibility > 0.5 and L[12].visibility > 0.5
    sw = abs(L[11].x - L[12].x)
    cx = (L[11].x + L[12].x) / 2
    distance = SW_MIN <= sw <= SW_MAX
    centered = abs(cx - 0.5) <= CX_TOL
    hands_ok = nh >= 1

    if not (face and shoulders):
        g = "Enquadre o rosto e os ombros na câmera."
    elif not centered:
        g = "Centralize-se no quadro."
    elif sw < SW_MIN:
        g = "Aproxime-se um pouco da câmera."
    elif sw > SW_MAX:
        g = "Afaste-se um pouco da câmera."
    elif not hands_ok:
        g = "Mantenha as mãos à mostra (sobre a mesa)."
    else:
        g = "Posição ok!"

    print(json.dumps({
        "ok": bool(face and shoulders and distance and centered and hands_ok),
        "checks": {"face": face, "shoulders": shoulders, "distance": distance,
                   "centered": centered, "hands": hands_ok,
                   "shoulder_width": round(sw, 3), "center_x": round(cx, 3)},
        "guidance": g,
    }))


main()
