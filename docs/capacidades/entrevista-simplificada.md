# Entrevista simplificada

> **Estado:** em produção · revisado em 2026-08-15
> `works.kind = 'interview'` · `works.interview_variant = 'realtime'`

**Uma frase:** o aluno conversa por voz, em tempo real e com a câmera aberta,
sobre o trabalho que entregou — mas o arguidor percorre apenas as perguntas
preparadas de antemão, sem raciocinar a cada turno.

## Para quem serve

É o meio-termo entre a prova oral e a entrevista profunda: as perguntas vêm do
trabalho **daquele** aluno (como na profunda), mas a conversa é fluida e falada
(como na prova oral), sem o custo do raciocínio por turno.

## O que o professor configura

Exatamente o mesmo que a [entrevista profunda](entrevista-profunda.md) — a
configuração e o pipeline de avaliação são compartilhados. O que muda é a
**variante**, escolhida no trabalho.

## O que o aluno vive

1. Envia o trabalho em PDF, como na profunda.
2. Passa pelo mesmo portão de setup da prova oral — posição, mãos, celular,
   ruído, conexão — e pelo **gate de vídeo obrigatório**.
3. Conversa por voz com o entrevistador, que faz as perguntas do plano montado a
   partir do trabalho dele.
4. Ao encerrar, a transcrição é convertida para o mesmo formato de conversa das
   outras formas, o que a liga ao pipeline de avaliação existente.

## O que sai no fim

O mesmo conjunto da entrevista profunda: conversa, avaliação interna, nota por
rubrica e sinais de fiscalização.

**Um turno é uma pergunta do plano.** Confirmações, pontes e pedidos de
complemento — inevitáveis numa conversa falada — entram como intervenções do
turno, não como turnos novos. Antes cada um deles abria um turno, e a avaliação
comentava ponte de transição como se fosse questão avaliável: um aluno chegou a
14 turnos para 5 perguntas. Ver [ADR 0016](../decisoes/0016-turno-e-pergunta-do-plano.md).

## O que esta capacidade NÃO faz

- **Não** aprofunda com base na resposta: o roteiro é fixo. Quem precisa de
  insistência usa a profunda.
- **Não** é mais barata que a entrevista profunda. Essa foi uma expectativa
  inicial que a medição desmentiu — ver
  [ADR 0008](../decisoes/0008-voz-realtime-nao-e-mais-barata.md).

## Cenários

- **Dado** um trabalho na variante em tempo real, **quando** o aluno conclui a
  sessão, **então** a transcrição vira conversa no mesmo formato das demais
  formas e a avaliação roda sem tratamento especial.
- **Dado** um aluno **sem fone de ouvido**, **quando** a entrevistadora fala,
  **então** o som pode retornar pelo microfone e disparar detecção de fala — a
  fala é cortada e o transcritor pode inventar respostas curtas em outra língua.
  *(Falha conhecida e observada em produção — ver as issues #137 e #138.)*

## Referência técnica

`routes/interviewLive.js`, `lib/liveInterview.js`, `lib/liveConversation.js`,
`static/live-student.html`. O motor de relay é o mesmo da prova oral
(`lib/realtimeBridge.js`) — mudança ali afeta as duas.

## Decisões relacionadas

- [ADR 0003 — Análise sempre em texto](../decisoes/0003-analise-sempre-em-texto.md)
- [ADR 0005 — Vídeo obrigatório e bloqueante](../decisoes/0005-video-obrigatorio-e-bloqueante.md)
- [ADR 0008 — Voz em tempo real não é mais barata](../decisoes/0008-voz-realtime-nao-e-mais-barata.md)
