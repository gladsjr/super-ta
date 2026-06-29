---
name: Dirigir o VAD Realtime com áudio sintético (harness de voz)
description: Por que provas de voz sintéticas commitam turnos de forma não-determinística e como tornar o harness confiável.
---

# Dirigir o semantic_vad de produção com TTS sintético

Ao validar a prova oral por voz (oral_realtime) com um cliente sintético (TTS → frames PCM16 24kHz no relay), o examinador real conduz, mas o **fechamento de turno do aluno é não-determinístico**: às vezes o VAD detecta o início da fala (`speech_started` ⇒ status `listening`) mas **nunca fecha o turno** (`speech_stopped` ⇒ status `thinking`), então o examinador não responde e a sessão trava até o timeout.

**Causa raiz:** a sessão de produção usa `semantic_vad` (eagerness="low", paciente) + `noise_reduction="far_field"`, calibrados para um humano numa sala. Enviar **silêncio digital perfeito (zeros)** no fim da fala não produz uma transição fala→silêncio detectável de forma confiável (um mic real nunca gera zeros; tem piso de ruído). Sintoma no billing: `inAudio=0, responses=1, clean=false` (áudio do aluno nunca commitado, logo não cobrado).

**O que ajuda (não elimina):** adicionar um **piso de ruído** baixo e constante ao áudio e ao "silêncio" final, imitando uma sala silenciosa.
- Silêncio digital perfeito (amp 0): trava cedo (turno 1).
- Piso de ruído muito alto (amp ~40 int16): re-dispara `speech_started` no rabo do silêncio ⇒ turno nunca fecha.
- Amplitude baixa demais (amp ~10): volta a se aproximar do caso-zero, flaky.
- Amp ~18 na fala + ~30 no silêncio final (~3s) é o melhor ponto observado; ainda assim ~2/3 turnos commitam de forma confiável.

**Conclusão / como aplicar:** trate isso como limitação do harness (malha-aberta contra VAD calibrado p/ humano), **não defeito do produto**. Faça o gate de PASS do passo de voz refletir o comportamento do PRODUTO (examinador conduziu + ≥1 turno do aluno commitado pelo VAD real + encerramento limpo via `bye`), e trate o nº exato de respostas como informativo. As provas reais (oral_transcript, oral_asked_json, oral_video_key, custo `event_type='realtime'`, evaluate-all, proctor-all, visão do professor) são gates próprios. Um humano real (fala contínua, com piso de ruído natural) fecha os turnos de forma muito mais confiável — é exatamente para isso que a config foi calibrada.

**Fora de escopo automatizado:** o preflight MediaPipe (câmera/face) é só no navegador; valide manualmente. O sidecar de mãos (`scripts/proctor_hands.py`, mediapipe Python) falha em silêncio no dev (módulo ausente) — esperado.
