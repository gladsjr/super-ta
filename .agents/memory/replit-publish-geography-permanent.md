---
name: Replit publish geography é permanente (e colocada com o DB)
description: Região da publicação trava na 1ª publish; trocar = nova deployment + DB novo + redomínio; relay realtime força 1 perna longa de rede
---

No Replit, a geografia da publicação é escolhida na **1ª publicação** (Publishing → Advanced) e **não muda depois**. Compute + Postgres de prod + Object Storage ficam **colocados** na mesma região.

**Consequência:** "trocar de região" de um app já publicado = criar uma NOVA deployment na região desejada → banco de dados novo (migrar dados), reapontar domínio custom, downtime. Operação grande e parcialmente irreversível — **não é um toggle**.

**Para voz em tempo real (prova oral):** o áudio é relay (navegador→servidor→OpenAI→volta), então a latência total tem sempre UMA perna longa de rede, independente da região — mover a região só troca QUAL perna é longa (aluno↔VM vs VM↔OpenAI). O dev (que ficou fluido) roda em North America, perto do Realtime da OpenAI.

**How to apply:** se pedirem para "aproximar a região", PRIMEIRO confirme a região atual (Publishing→Advanced). Se já for North America, região não é o gargalo → investigue capacidade da VM (proctoring de vídeo YOLO/ffmpeg e avaliação rodam na MESMA Vma única) e a falta de backpressure no relay (`clientWs.send` sem checar `bufferedAmount`). Meça a latência real antes de qualquer mudança cara de região.
