# 0012 — Na prova oral, nota e devolutiva publicam juntas

> **Estado:** Aceita
> **Data:** 2026-08-15

## Contexto

A [ADR 0009](0009-nota-e-devolutiva-publicam-separado.md) estabeleceu publicações
**independentes** para nota e devolutiva, valendo para os dois produtos. Isso
habilita a ordem pedagógica de devolver o retorno formativo primeiro, ouvir o
aluno, e só então fechar a nota — algo real na **entrevista**, onde a devolutiva
é uma peça central, gerada e revisada.

Na **prova oral**, o teste com professor (issue #207) mostrou que esse mesmo
modelo só gera atrito: ali a devolutiva virou um **campo livre e opcional** (sem
geração por IA), curto, escrito junto com o lançamento das notas. Dois controles
de publicação separados, num fluxo em que o professor abre a tela do aluno,
lança as notas e escreve (ou não) uma devolutiva de uma vez, eram estado a mais
sem ganho — e reproduziam o 409 "gere a rubrica antes de avaliar" descoberto
tarde. A decisão do professor (dono do produto) foi unificar a publicação na
prova oral.

## Decisão

- Na **entrevista** (por mensagem e simplificada), nota e devolutiva seguem com
  **publicações independentes** — a ADR 0009 continua valendo ali.
- Na **prova oral**, a devolutiva é publicada e despublicada **junto com a nota**:
  um único controle. O aluno lê ambas quando a nota está publicada
  (`grade_published_at`); o professor não publica uma sem a outra.

Ou seja: 0012 **supersede** a 0009 apenas no escopo da prova oral; a 0009 passa a
descrever só o comportamento da entrevista.

## Consequências

- Dois modelos de publicação coexistem — a UI e o backend divergem por tipo de
  trabalho. Quem mexer em publicação precisa saber em qual produto está.
- Na prova oral some a flexibilidade de ordem (não dá para devolver o retorno e
  segurar a nota, nem o contrário). Aceitável: a devolutiva ali é opcional e
  curta, não o eixo do retorno como na entrevista.
- A tela do aluno da prova oral fica mais simples (um estado de publicação, não
  dois); o painel do professor perde um botão.
