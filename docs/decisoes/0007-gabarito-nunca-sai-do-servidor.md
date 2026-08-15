# 0007 — O gabarito nunca sai do servidor

> **Estado:** Aceita
> **Data:** 2026-07 (registrada em 2026-08-15)

## Contexto

Na prova oral, cada questão tem enunciado e resposta esperada. A sessão de voz
roda no navegador do aluno, conversando com a API em tempo real. Se a resposta
esperada fizesse parte do material da sessão, ela estaria ao alcance de quem
inspecionasse o tráfego — e a prova estaria comprometida.

## Decisão

Apenas as **perguntas** deixam o servidor. A resposta esperada e o critério de
correção permanecem no servidor e só são usados na avaliação posterior, sobre a
transcrição.

## Consequências

- O examinador em tempo real **não sabe** a resposta certa; ele conduz, não
  corrige. Quem corrige é a avaliação posterior, com o gabarito em mãos.
- Não é possível dar retorno imediato de acerto ao aluno durante a prova. Aceito.
- Invariante de privacidade não negociável: qualquer mudança no relay precisa
  preservá-la.
