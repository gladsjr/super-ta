# Harness de teste ponta a ponta

> **Estado:** em produção · revisado em 2026-08-15
> Usuário desta capacidade: **a equipe**.

**Uma frase:** um arcabouço que conduz uma arguição inteira dirigindo o sistema
real de fora — navegador de verdade, microfone falso, aluno simulado por outro
modelo — para provar que a cadeia funciona antes de um aluno real encontrar o
defeito.

## Dois termos, para tirar da frente

**Ponta a ponta** (em inglês *end-to-end*, abreviado *E2E*): o teste exercita o
caminho **inteiro**, da interface do aluno até o registro que o professor vê,
sem substituir peça nenhuma por simulação. O contrário seria testar cada função
isoladamente — útil, mas incapaz de pegar o defeito que só aparece quando as
peças se encontram.

**Harness**: o arcabouço que dirige o sistema de fora, no lugar do usuário. Ele
não é parte do produto; é o aparato que exercita o produto.

## Para que serve

A arguição por voz tem uma cadeia longa e frágil: gravar no navegador, enviar,
transcrever, raciocinar, sintetizar voz, transmitir, tocar, registrar. Qualquer
elo quebrado só aparece na sessão real — e sessão real é aluno de verdade, em
prova valendo nota. O harness paga por si na primeira vez que pega um elo
partido antes disso.

## O que ele faz

1. Sobe o servidor se não estiver no ar, cria o trabalho e o envio.
2. Abre um Chrome controlado sobre a **tela real do aluno**.
3. Substitui o microfone: em vez de hardware, injeta a fala sintetizada do aluno
   simulado direto no fluxo de áudio que a página grava. Sem microfone físico e
   sem reiniciar o navegador entre turnos.
4. A cada turno, **lê a pergunta que o entrevistador realmente fez**, pede ao
   aluno simulado uma resposta para *aquela* pergunta, sintetiza e injeta. O
   laço é dinâmico: pergunta imprevista não quebra o teste.
5. Ao final, salva relatório, transcrição, o registro pelo lado do professor e
   **todos os áudios** para auditoria humana.

Personas de aluno disponíveis: bem preparado, enrolando, inseguro.

## A família de harnesses

| Harness | Exercita |
|---|---|
| Modo áudio (`npm run test:audio`) | A entrevista falada ponta a ponta, no navegador. |
| A/B do orquestrador (`npm run test:ab-orchestrator`) | Qualidade e custo do modelo forte contra o rápido, sem servidor e sem banco. |
| Prova oral e entrevista em tempo real | Encerramento e ciclo de vida das sessões de voz. |
| Cenários | Qualidade da condução multiagente, com juiz. |

O A/B merece nota à parte pelo desenho: ele isola **uma** variável. A preparação
roda uma vez no modelo forte e é **compartilhada pelos dois braços**, então as
condições iniciais são idênticas; o aluno simulado é fixo nos dois braços,
porque ele não está sob teste. E mede qualidade por dois caminhos
complementares: pareado por turno, avaliando o modelo rápido no **mesmo estado
congelado** em que o forte decidiu, e holístico, comparando entrevistas
completas e independentes com o juiz lendo transcrições anonimizadas em ordem
sorteada.

## O que esta capacidade NÃO faz

- **Não** julga qualidade nem naturalidade de voz. O harness não escuta: ele
  valida a cadeia funcional e salva os áudios para ouvido humano.
- **Não** substitui aluno real. Aluno simulado é comparável entre braços, não
  representativo em termos absolutos — o que já se confirmou na prática, com o
  simulador reagindo a mudanças de forma mais decidida que gente de verdade.
- **Não** é gratuito: cada execução gasta token real de transcrição, síntese e
  raciocínio. Por isso o padrão são três perguntas.
- **Não** roda contra produção.

## Cenários

- **Dado** que o entrevistador fez uma pergunta que não estava no plano,
  **quando** o laço avança, **então** o aluno simulado responde àquela pergunta
  e o teste segue.
- **Dado** que a entrevista terminou sem erro de página, **quando** o processo
  encerra, **então** o código de saída é zero — e qualquer outro valor pede
  revisão humana.
- **Dado** que alguém quer conferir se a voz saiu natural, **quando** abre a
  pasta da execução, **então** encontra os áudios de entrevistador e aluno
  separados por turno.
- **Dado** um smoke barato do A/B, **quando** se reduz a uma persona e uma
  repetição, **então** o custo cai proporcionalmente.

## Referência técnica

`tests/audio-e2e/` (com `README.md` próprio, `inject.js` para o microfone falso,
`student.mjs` para as personas), `tests/ab-orchestrator/` (com desenho do
experimento e rubrica do juiz em seu `README.md`), `tests/oral-e2e/`,
`tests/live-ending-e2e.mjs`, `tests/scenario-eval.mjs`.
Atalho para o Claude Code: a skill `testar-modo-audio`.

## Decisões relacionadas

- [ADR 0003 — Análise sempre em texto](../decisoes/0003-analise-sempre-em-texto.md)
- [ADR 0006 — Um raciocínio por turno, guardas no código](../decisoes/0006-um-raciocinio-por-turno.md)
