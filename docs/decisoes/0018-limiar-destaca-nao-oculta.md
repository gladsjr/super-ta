# 0018 — O limiar da fiscalização destaca, não oculta; celular mede segundos

> **Estado:** Aceita
> **Data:** 2026-08-16

## Contexto

Duas telas mostravam o MESMO relatório de fiscalização de formas opostas. A lista
de alunos disparava "celular" com `pct >= 5 ou count >= 10`; a tela individual só
mostrava com `pct >= 25`. Um aluno com 3% e 23 quadros aparecia sinalizado na
lista e, ao abrir, exibia **"nenhum alerta relevante"**. O professor via o sinal
e não encontrava nada.

Pior que a divergência: na tela individual o limiar **ocultava** o eixo inteiro.
Sinal real abaixo do corte simplesmente sumia — inclusive os números que
permitiriam ao professor julgar.

E o percentual é a métrica errada para celular: o uso dura poucos segundos, e o
percentual dilui isso numa prova longa (3% de 11 minutos).

## Decisão

**Uma fonte única de limiares** (`static/js/proctorAxes.js`), consumida pela
lista e pela tela individual.

**O limiar DESTACA, não OCULTA.** Todo eixo analisado aparece sempre, com seus
números; o limiar decide a cor. "Não analisado" é um terceiro estado, distinto de
"ok" — sidecar ausente não é ausência de problema.

**Celular passa a ser medido em segundos**, com dois gatilhos: sequência contígua
≥ 10 s (estava com o aparelho na mão) ou total ≥ 30 s (espalhado, porém
abundante). O percentual é aposentado para esse eixo, e `max_run_sec` passa a ser
calculado também para celular — como já era para "mais de uma pessoa", e pelo
mesmo motivo.

## Consequências

- O falso positivo confirmado por revisão humana (23 s espalhados em 11 min)
  **deixa de alertar e continua visível**, com a contagem bruta ao lado. É o
  comportamento certo: o professor decide, com o número à mão.
- `max_run_sec` só existe em análises novas — `at` guarda apenas os 8 primeiros
  carimbos, então não dá para reconstruir a sequência de um relatório salvo. O
  consumidor degrada para o total, e só uma reanálise dá o sinal melhor.
- A posição do dono continua valendo: **prefere falso positivo a falso negativo**.
  A mudança reduz FP sem endurecer o detector — mexe em exibição, não em detecção.
