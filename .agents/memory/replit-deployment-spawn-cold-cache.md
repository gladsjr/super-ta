---
name: Deployment do Replit — primeiro spawn depois do Publish é muito lento
description: ffmpeg/python demoram 15 s no primeiro toque após o Publish (cache frio do sistema de arquivos); em regime, 0,8 s / 2,8 s. O boot aquece.
---

Medido pelo health check `deep` em 08/09/2026 (#375), no deployment (Reserved VM):

| spawn | 1ª vez após o Publish | em regime |
|---|---|---|
| `ffmpeg -version` | 15 s | 0,8 s |
| `python -c "import mediapipe"` | 14 s | 2,8 s |
| inferência ONNX (sessão já aberta) | 3,6 s | 0,4–0,8 s |

O sistema de arquivos do deployment carrega binários e bibliotecas do nix
store sob demanda: o primeiro toque paga I/O. Enquanto isso acontece, a
latência do banco vista pelo processo sobe (2,5 s em vez de ~0,4 s).

**Consequência:** a primeira análise de vídeo depois de cada Publish pagava
~30 s extras, e se caísse no meio de uma prova, a prova sentia.

**O que se faz:** `lib/warmup.js#warmUpNativeDeps`, aguardado no boot em
`server.js` (depois do `listen`, ANTES de `initProctorQueue`, com teto de
90 s), toca `ffmpeg` e `python+mediapipe` com nice 19, logando `[WARMUP]`.
Não é análise, é só o toque nos arquivos. A fila só liga depois — um reinício
com backlog reivindica no primeiro tique. E o health `deep` roda os checks
externos DEPOIS da sequência de banco, para o número do banco não refletir a
carga que o próprio relatório gerou.

**Não conclua** que o spawn é lento por natureza no Replit: em regime é o
custo normal. Se um dia o `[WARMUP]` do boot mostrar segundos de novo em
chamadas seguidas, aí é outra coisa.
