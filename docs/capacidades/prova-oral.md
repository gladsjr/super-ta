# Prova oral

> **Estado:** em produção · revisado em 2026-08-15
> `works.kind = 'oral_realtime'`

**Uma frase:** o aluno responde, falando e com a câmera aberta, a perguntas
sorteadas de um conjunto que o professor preparou a partir do material da
disciplina — e a nota sai da rubrica de cada pergunta.

## Para quem serve

Verificação frequente e comparável entre alunos da mesma turma. É a forma mais
curta e mais barata das três, e a única em que as perguntas **não** dependem do
que o aluno entregou — todos são arguidos sobre o mesmo conteúdo.

## O que o professor configura

- **Material da prova** (PDF ou texto): dele o sistema extrai pares
  *pergunta + resposta esperada*.
- **As perguntas**, que ele revisa e edita. Cada uma tem: enunciado, resposta
  esperada (o gabarito), **rubrica em cinco níveis** (0 · 2,5 · 5 · 7,5 · 10) e
  um **peso**. A rubrica pode ser gerada a partir da resposta esperada ou escrita
  à mão; quando a pergunta ou a resposta muda, a rubrica é marcada como
  desatualizada para revisão.
- **Quantas perguntas cada aluno recebe** — se for menos que o total, o sistema
  sorteia por aluno e registra quais caíram.
- **Voz** do examinador e, opcionalmente, uma **frase de calibração** de fala.

## O que o aluno vive

1. Abre o link individual e passa por um **portão de setup** no navegador:
   posição diante da câmera, mãos à vista, ausência de celular, ruído ambiente e
   teste de conexão. Posição e ruído apenas orientam; **a captura de vídeo é
   bloqueante** — sem gravação, a prova não começa.
2. Se o trabalho tem frase de calibração, lê a frase em voz alta. O resultado
   nunca impede a prova (duas tentativas e segue): serve para avisar sobre volume
   e ritmo, e para sinalizar ao professor problemas de captação.
3. Faz a prova **falando com o examinador**, em tempo real. Se a câmera cair no
   meio, o áudio é suspenso até a captura voltar.
4. A prova **encerra sozinha** ao fim das perguntas, sempre com uma despedida
   falada. Há um botão para encerrar antes.

## O que sai no fim

- **Transcrição** da prova, em ordem de conversa.
- **Nota por rubrica**: cada pergunta recebe uma nota ancorada em 0/2,5/5/7,5/10
  segundo a sua rubrica; a nota da prova é a média ponderada pelos pesos. Ela
  nasce como sugestão editável.
- **Sinais de fiscalização** do vídeo (ver [fiscalização](fiscalizacao-por-video.md)).
- **Devolutiva ao aluno** — hoje existe, mas está [em revisão](devolutiva.md).

## O que esta capacidade NÃO faz

- **Não** pergunta sobre o trabalho do aluno — para isso existem as entrevistas.
- **Não** aprofunda: o examinador não improvisa perguntas de acompanhamento a
  partir da resposta; ele percorre as perguntas sorteadas.
- **Não** entrega o gabarito ao navegador nem à sessão de voz. Só as perguntas
  saem do servidor — ver [ADR 0007](../decisoes/0007-gabarito-nunca-sai-do-servidor.md).
- **Não** interrompe a prova por causa de posicionamento ou ruído.
- **Não** acusa ninguém automaticamente a partir do vídeo — ver
  [ADR 0004](../decisoes/0004-proctoring-nao-acusa-automaticamente.md).

## Cenários

- **Dado** um trabalho com 10 perguntas e o limite de 6 por aluno, **quando** dois
  alunos fazem a prova, **então** cada um recebe um sorteio próprio e o conjunto
  sorteado fica registrado no seu envio.
- **Dado** um aluno cujo navegador não consegue gravar vídeo, **quando** ele tenta
  começar, **então** a prova é bloqueada com orientação — e o professor pode
  liberá-lo individualmente.
- **Dado** que o aluno terminou de responder a última pergunta, **quando** o
  examinador reconhece a resposta, **então** a prova encerra com uma despedida
  falada, mesmo que o modelo não a tenha produzido.
- **Dado** que a câmera do aluno é desconectada no meio da prova, **quando** ele
  volta a falar, **então** o áudio não é encaminhado até a captura ser restaurada.
- **Dado** uma pergunta sem rubrica, **quando** o professor manda avaliar,
  **então** a avaliação é recusada em vez de inventar um critério.

## Referência técnica

[`docs/oral-exam.md`](../oral-exam.md) — relay, encerramento garantido, portão de
setup, calibração, agentes e schema.
[`docs/video-proctoring.md`](../video-proctoring.md) — gate de vídeo (compartilhado).

## Decisões relacionadas

- [ADR 0004 — Fiscalização não acusa automaticamente](../decisoes/0004-proctoring-nao-acusa-automaticamente.md)
- [ADR 0005 — Vídeo obrigatório e bloqueante](../decisoes/0005-video-obrigatorio-e-bloqueante.md)
- [ADR 0007 — O gabarito nunca sai do servidor](../decisoes/0007-gabarito-nunca-sai-do-servidor.md)
