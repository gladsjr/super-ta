# Fiscalização por vídeo

> **Estado:** em produção · revisado em 2026-08-15
> `works.proctoring_enabled` · vídeo obrigatório desde a migration 072 (2026-08-14)

**Uma frase:** a câmera fica aberta durante toda a arguição, a gravação é
obrigatória para a sessão acontecer, e a análise posterior produz **sinais para
o professor olhar** — nunca uma acusação.

## Para quem serve

Situações em que a integridade precisa ser demonstrável: prova valendo nota,
avaliação a distância, exigência institucional de registro. Vale para as três
formas de arguição.

## O que o professor configura

- **Ligar ou desligar** por trabalho.
- Opcionalmente, uma orientação sobre como (e se) os alertas de vídeo podem
  aparecer, em tom não acusatório, na devolutiva do aluno.
- **Liberar um aluno específico** cujo equipamento não consegue gravar.

## O que o aluno vive

- **Consentimento** antes de começar (LGPD).
- Um **portão de setup**: enquadramento (tronco à cabeça, ~1,5 m da câmera),
  mãos à vista, ausência de celular, ruído e conexão.
- Na entrevista por mensagens em modo voz, o aluno comanda o turno por **áreas de
  comando nos cantos da tela** — mantém a mão sobre a área por uma contagem de
  1‑2‑3. Não é botão nem reconhecimento de gesto: a versão por gesto foi
  substituída depois de teste ao vivo, porque as áreas de canto se mostraram
  muito mais robustas.
- A gravação corre durante toda a sessão e é enviada ao final.

## O gate em três camadas

Vídeo é **obrigatório e bloqueante**. A regra vale nos três fluxos:

| Camada | Quando | O que faz |
|---|---|---|
| Início | antes de conectar | Grava um trecho de teste. Sem captura, a sessão não começa. Pega navegador sem suporte e câmera que abre mas não grava. |
| Meio | durante | Se a câmera cai (permissão revogada, webcam desconectada), a gravação de resposta trava e o áudio deixa de ser encaminhado até voltar. |
| Fim | ao encerrar | O servidor não conclui sem vídeo: a submissão fica **aguardando vídeo** até o envio chegar. |

A válvula de escape é o professor liberar o aluno individualmente.

## Cobertura da análise

A análise gasta um **orçamento fixo de quadros** (proteção de CPU) distribuído
ao longo do vídeo **inteiro**: prova curta é amostrada a cada segundo; prova
longa estica o passo. Até 2026-08-16 esse orçamento era um teto que truncava
em 20 minutos **sem registrar nada** — uma prova de 44 minutos era analisada
até a metade e o relatório parecia completo. O relatório agora traz duração
real, janela coberta e marca de truncamento, e o painel avisa quando a
cobertura é parcial. Atenção ao ler: com passo esticado, `count` está em
quadros, não em segundos — use `count_sec`.

## O que sai no fim

Alertas por categoria — ausência, mais de uma pessoa, celular, mãos — como
**pastilhas para revisão humana**. **A gravação em várias partes é, ela mesma,
um alerta**: significa que a câmera caiu durante a arguição e a sessão foi
pausada e retomada a cada queda. O player navega entre as partes e emenda
sozinho; clicar num trecho encontra a parte certa, com o vídeo disponível para o professor
assistir e navegar. Detecção de celular passa por uma segunda checagem com
recorte ampliado, porque mão gesticulando perto do rosto é o falso positivo
dominante; para "mais de uma pessoa", registra-se a maior sequência contínua,
já que uma segunda pessoa real persiste e o próprio braço do aluno na borda dura
um ou dois segundos.

## O que esta capacidade NÃO faz

- **Não** rebaixa nota automaticamente. A penalidade automática existiu e foi
  **removida em 2026-08-13** — ver [ADR 0004](../decisoes/0004-proctoring-nao-acusa-automaticamente.md).
- **Não** interrompe a arguição por posicionamento ou ruído.
- **Não** manda o vídeo para a OpenAI. A análise é local, no servidor.
- **Não** entra no raciocínio da avaliação de conteúdo — integridade e conteúdo
  são mantidos separados de propósito.
- **Não** promete impedir fraude. O que ela faz é registrar e sinalizar.

## Cenários

- **Dado** um aluno com a câmera bloqueada pelo navegador, **quando** ele tenta
  começar, **então** recebe erro bloqueante com orientação e a sessão não inicia.
- **Dado** que a arguição terminou mas o envio do vídeo falhou, **quando** o
  professor abre o painel, **então** vê a submissão como "aguardando vídeo" — e
  ela é promovida sozinha quando o envio finalmente chega.
- **Dado** um aluno gesticulando perto do rosto, **quando** a análise roda,
  **então** a detecção de celular só conta os quadros confirmados na segunda
  checagem.
- **Dado** alertas de vídeo em um aluno, **quando** o professor calcula a nota,
  **então** a nota é a média ponderada da rubrica, sem desconto automático.

## Referência técnica

[`docs/video-proctoring.md`](../video-proctoring.md) — áreas de comando, gate,
schema. [`docs/oral-exam.md`](../oral-exam.md) — o núcleo de proctoring nasceu ali.

## Decisões relacionadas

- [ADR 0004 — Fiscalização não acusa automaticamente](../decisoes/0004-proctoring-nao-acusa-automaticamente.md)
- [ADR 0005 — Vídeo obrigatório e bloqueante](../decisoes/0005-video-obrigatorio-e-bloqueante.md)
