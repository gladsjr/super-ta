---
name: Proctoring FPs — mãos viram "celular" e braço vira "2ª pessoa"
description: Padrões de falso positivo do yolov8n em vídeo de webcam e a mitigação zoom-verify validada com frames reais.
---

**Padrões medidos (vídeo real de entrevista com aluno gesticulando):**
- Mão/antebraço levantado perto do rosto → "cell phone" com conf 0.27–0.55 e área ~1% (46 frames num vídeo de 535, ZERO celulares). Pose de "mão na boca/ajustando fone" é o pior caso.
- Braço do próprio aluno na borda do quadro → "person" extra com conf 0.37–0.81, dura 1–2 s contíguos.

**Mitigação validada — zoom-verify:** recortar o box suspeito com margem ~2.5×, ampliar para 640 e re-inferir; só confirmar o flag se o celular reaparecer. Eliminou 85% dos FPs (46→7). Só CONFIRMA, nunca cria → FP estritamente não-crescente.

**Limite conhecido:** confiança NÃO separa mão de celular (FPs sobreviventes confirmam no zoom a 0.28–0.49, faixa que um celular real parcialmente oculto também ocupa). Não subir o limiar de confirmação sem amostras POSITIVAS (vídeo com celular real) para medir recall.

**Para 2ª pessoa o zoom não discrimina** (o recorte sempre contém o próprio aluno) — o discriminador é persistência temporal (`max_run_sec`): pessoa real fica muitos segundos; gesto dura 1–2 s.

**Why:** proctoring alimenta penalidade de nota e a confiança do professor; FPs recorrentes minam o produto.
**How to apply:** ao ajustar limiares de alerta de proctoring, usar `raw_count` vs `count` (confirmado) e `max_run_sec` já gravados nos relatórios — dá para recalibrar sem reprocessar vídeo. Validação barata: baixar o vídeo do bucket (compartilhado dev/prod), extrair frames flagados com ffmpeg e OLHAR.
