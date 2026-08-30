---
name: oratia-revisao
description: >-
  Conduz o portão de revisão independente do ORATIA: como submeter um plano ou
  uma implementação ao agente oratia-revisor, como ler os apontamentos BAIXO,
  MODERADO e CRÍTICO, o laço de reformulação e quando escalar ao usuário. Use
  ao concluir um plano, ao terminar uma implementação, antes de commitar ou
  abrir PR, e sempre que for dar uma entrega por pronta — frases como "revisa
  isso", "está pronto?", "pode commitar?", "submete para revisão", "o revisor
  reprovou". NÃO use para executar o trabalho em si (use oratia-improve para
  produto; oratia-ambiente, oratia-build ou oratia-deploy para ambiente).
---

# Portão de revisão independente

Todo plano e toda implementação atravessam este portão antes de serem dados por
entregues. A regra está no `PRIMER.md`; aqui está como executá-la.

## Quando

**Exige revisão**: plano de trabalho, código, migration, prompt, skill,
manifesto, roteiro, primer, Dockerfile, compose, ferramental.

**Isento** — lista fechada:

1. correção de typo ou reformatação **sem efeito observável** em comportamento,
   instrução ou saída;
2. o registro da própria revisão.

Na dúvida sobre estar isento, **não está**. A lista é fechada para não virar
brecha: "é só um ajuste rápido" não consta dela.

Revise **antes** de commitar, não depois. Reprovação depois do commit obriga a
desfazer ou emendar — e emendar história já enviada é pior que revisar antes.

## Como submeter

Chame o subagente `oratia-revisor` declarando três coisas. Faltando o
**objetivo**, ou o **diff** quando for implementação, o revisor devolve
MODERADO antes de julgar o resto — e com razão: sem objetivo não há critério, e
sem diff ele julgaria o arquivo inteiro em vez da mudança. Ciclo ausente ele
infere, e aponta BAIXO.

1. **Objetivo** — o que a entrega se propõe a fazer, em uma ou duas frases.
2. **O que mudou** — arquivos tocados. Para implementação, inclua o diff ou a
   lista de alterações por arquivo.
3. **Ciclo** — produto (`super-ta/`) ou SDLC (raiz do workspace).

O revisor tem apenas leitura (`Read`, `Grep`, `Glob`), por desenho: ele não
pode alterar o que julga. Como não roda comandos, **é você quem fornece o
diff** — sem ele, a revisão de implementação fica cega ao que de fato mudou.

Um esboço do que passar:

```
Objetivo: <o que a entrega faz e para quê>
Ciclo: produto | SDLC
Arquivos alterados:
  <caminho> — <o que mudou nele>
Diff:
  <saída de git diff, ou a lista de alterações>
Contexto: <restrição, decisão do usuário, o que ficou deliberadamente de fora>
```

Inclua no contexto **o que você deixou de fora de propósito**. Sem isso, o
revisor aponta como lacuna o que foi escolha — e você gasta uma rodada
explicando.

## Como ler o resultado

| Grau | Efeito |
|---|---|
| **BAIXO** | Não reprova. Corrija se for barato; se não, registre e siga |
| **MODERADO** | **Reprova.** Reformule |
| **CRÍTICO** | **Reprova.** Reformule |

Um único MODERADO ou CRÍTICO reprova. **APROVADO com apontamentos BAIXO é
aprovação de verdade** — não fique iterando para zerar o que não reprova.

## O laço, e onde termina

```
submete → REPROVADO → reformula → submete → REPROVADO → reformula
        → submete → REPROVADO → PARA e escala
```

**Após a terceira reprovação, pare.** Não submeta uma quarta vez. Apresente ao
usuário:

- o apontamento que **persiste**, no texto do revisor;
- o que você **já tentou** nas rodadas anteriores;
- sua **leitura** de onde está o problema — na entrega ou no critério;
- as **opções**: seguir corrigindo, dispensar o apontamento, ou mudar o escopo.

Isso não é desistir. Três reprovações costumam significar que o apontamento
está calibrado errado, que o objetivo declarado está impreciso, ou que a
entrega precisa de uma decisão que só o usuário toma. Insistir sozinho esconde
os três casos.

**Reincidência escala antes do teto.** Se o MESMO apontamento sobreviver a uma
reformulação que dizia tê-lo corrigido, não gaste as rodadas restantes: escale
já. Sobrevivência é sinal de desentendimento sobre o critério, e mais uma
tentativa às cegas não o resolve.

Ao reformular, **corrija a causa, não o sintoma do apontamento.** Reescrever
para o revisor parar de reclamar é como contornar um teste em vez de consertar
o código.

## Registro

O resultado da revisão vive onde a entrega vive — **não crie arquivo de log**,
que apodreceria como qualquer duplicata:

| Ciclo | Onde registrar |
|---|---|
| Produto | descrição do PR: veredicto, apontamentos que sobraram e por que foram aceitos |
| SDLC | mensagem do commit, quando houver apontamento aceito ou decisão de escopo |

Não registre revisão limpa sem apontamento: ruído. Registre o que **sobrou** —
apontamento BAIXO aceito conscientemente, ou o que o usuário dispensou.

## O que este portão não é

- **Não substitui teste.** Aprovado não significa que funciona; significa que
  serve ao objetivo e não fere norma. A matriz de validação em `oratia-improve`
  diz o que rodar por tipo de mudança.
- **Não substitui revisão humana de PR** no ciclo de produto. Ele antecede.
- **Não é lugar de negociar o critério.** Se a norma está errada, isso é uma
  mudança de SDLC, com seu próprio ciclo — e sua própria revisão.
