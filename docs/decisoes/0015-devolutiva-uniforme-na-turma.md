# 0015 — O formato da devolutiva é uniforme na turma, não escolha do modelo

> **Estado:** Aceita
> **Data:** 2026-08-16

## Contexto

A seção pergunta a pergunta (`per_question`) da devolutiva do aluno era
**opcional por decisão do modelo**: o prompt mandava usá-la "só quando agregar".
O esquema exigia a chave, mas array vazio passava na validação.

Numa turma real, onze alunos receberam a seção e **um recebeu zero** — no mesmo
lote, mesmo trabalho, mesmo professor. O material existia: a avaliação interna
daquele aluno tinha cinco entradas. Só a versão dele saiu sem.

Não havia critério pedagógico por trás. Era variação não determinística do
modelo — na prática, sorteio.

## Decisão

Quando o relatório interno traz comentários por turno, a devolutiva **deve**
trazer uma entrada para cada um. A validação passa a exigir **cobertura
completa** e a rejeitar cobertura parcial ou vazia; o erro carrega uma orientação
que a retentativa injeta no prompt dizendo exatamente quais turnos faltaram.

Diretriz do professor pedindo texto corrido governa o **estilo** de cada entrada
e do resumo — não a existência da seção.

## Consequências

- Alunos da mesma turma passam a receber devolutivas com a mesma estrutura. É o
  ponto: equidade de tratamento entre colegas avaliados pelo mesmo instrumento.
- Mais rígido significa mais retentativa: uma devolutiva incompleta agora falha e
  repete em vez de passar. Custa alguns tokens a mais e, se estourar as
  tentativas, a geração falha em vez de entregar algo desigual — troca aceita.
- **Fica em aberto**: um professor que queira devolutiva sem a seção por opção
  pedagógica não tem como. O caminho certo é uma quinta seção em
  `FEEDBACK_SECTIONS` (`include_per_question`), que já dá padrão por trabalho e
  exceção por submissão — exige migration e um controle na tela, e não foi feito
  aqui para não mexer na interface do professor durante a correção.
- Na variante em tempo real, a causa provável do caso relatado era outra: turnos
  inflados faziam o modelo concluir que comentar questão a questão não agregava.
  Ver [ADR 0016](0016-turno-e-pergunta-do-plano.md).
