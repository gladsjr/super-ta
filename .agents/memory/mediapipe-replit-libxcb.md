---
name: MediaPipe/OpenCV no Replit (libxcb + .pythonlibs)
description: Como instalar o sidecar Python de proctoring (mediapipe/opencv) no Replit sem sujar o repo, e a lib de sistema que falta.
---

# Proctoring sidecar Python no Replit

O sidecar `scripts/proctor_hands.py` usa **mediapipe** (Hands + Pose). Sem ele, o painel
mostra "Mãos"/"Enquadramento" como *não analisado*; as 3 checagens YOLO (onnxruntime-node)
são independentes e continuam funcionando.

## Instalação limpa (sem tocar o repo)
- Pacotes Python vão para `.pythonlibs` (é o `PYTHONUSERBASE`, já no PATH). Instale com
  `python3 -m pip install --user -r requirements.txt` para NÃO reescrever `requirements.txt`
  (as ferramentas do skill de package-management re-pinam o manifesto).
- Adicione `.pythonlibs/` ao `.gitignore`. Assim como `node_modules`, o deploy VM leva o
  `.pythonlibs` do snapshot do workspace mesmo estando fora do git.

## A lib de sistema que falta
- **`import mediapipe` quebra com `libxcb.so.1: cannot open shared object file`.**
- Correção: adicionar `pkgs.xorg.libxcb` ao `replit.nix`.
- **Por quê importa:** `replit.nix` É versionado (vai ao GitHub). Se a tarefa exigir "nada
  versionado", isso é um conflito — pare e confirme antes de adicionar a dep de sistema.
- O sidecar importa só `mediapipe` (não `cv2`), então `opencv-python` do requirements não é
  usado em runtime; ainda assim mediapipe sozinho precisa do libxcb.

## Como validar sem vídeo real
- `ffmpeg -f lavfi -i testsrc=duration=6:size=640x480:rate=15 t.webm` e rodar
  `python3 scripts/proctor_hands.py t.webm`. Sucesso = JSON `{hands, framing}` e o `model`
  termina com `+ pose_landmarker (enquadramento)`. Conteúdo é sem sentido (sem pessoa), mas
  prova que mediapipe + modelos + ffmpeg carregam.
