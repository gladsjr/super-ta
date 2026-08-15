# Cenários multiagente

> **Estado: experimental** · revisado em 2026-08-15
> Subsistema autocontido em `/scenarios`. Não faz parte da oferta comercial.

**Uma frase:** em vez de uma arguição com um entrevistador, o aluno percorre uma
**sequência de encontros** com personas diferentes — cliente, regulador, chefe,
diretoria — sobre um caso montado pelo professor.

## Para quem serve

É a aposta de futuro do produto: sair da verificação de autoria e ir para
simulação profissional. O aluno de análise de sistemas levanta requisitos
entrevistando um cliente simulado; o de jornalismo entrevista uma fonte, escreve
e defende a matéria diante de um chefe de redação; a turma de negócios defende
decisões diante de investidor, regulador e diretoria.

## O modelo de domínio

- **Cenário** — a unidade de topo: nome, explicação geral, PDF do enunciado e uma
  **sequência ordenada de interações**. Não há biblioteca de cenários: um cenário.
- **Interação** — cada encontro da sequência. Pode ser aluno com uma ou várias
  personas, ou uma **troca entre duas personas** que o aluno assiste, com um foco
  declarado.
- **Template de persona** — biblioteca reutilizável, com voz e gênero.
- **Personas do cenário** — **cópias** editáveis instanciadas a partir dos
  templates. Editar a cópia não afeta o template; as interações referenciam as
  cópias.

## Como o professor monta

Um "estúdio" de formulários (sem YAML), em três abas na ordem de autoria:
cenário, personas, interações. Há um assistente que propõe cenário, personas e
interações em linguagem natural — mas **nunca salva sozinho**.

## Dois modos de execução

- **Simulado** — fabrica o formato de uma execução com roteiros fixos, **sem
  chamar modelo nenhum**. É o padrão do botão "Testar" no estúdio: prévia de
  interface a custo zero.
- **Real** — um raciocínio por turno escolhe qual persona fala e o que ela diz.
  As guardas (falante válido, teto de turnos por interação, memória determinística
  da execução) ficam **no código**, não no modelo — mesmo princípio da entrevista.

## O que esta capacidade NÃO faz

- **Não** tem áudio: é texto puro.
- **Não** está na oferta. É experimental e fica atrás de acesso de administrador.
- **Não** tem biblioteca de cenários prontos.

## Cenários

- **Dado** um cenário com três interações em sequência, **quando** o aluno conclui
  a primeira, **então** a segunda é destravada.
- **Dado** que o professor clica em "Testar" sem ligar a IA real, **quando** a
  execução roda, **então** nenhum token é consumido.
- **Dado** que o modelo indica um falante que não existe no cenário, **quando** o
  turno é processado, **então** o código normaliza ou rejeita, em vez de aceitar.

## Referência técnica

[`docs/scenarios.md`](../scenarios.md) — modelo, estúdio, motores e persistência.

## Decisões relacionadas

- [ADR 0006 — Um raciocínio por turno, guardas no código](../decisoes/0006-um-raciocinio-por-turno.md)
