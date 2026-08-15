# Histórico

**Nada aqui descreve o sistema de hoje.** São planos já executados e relatórios
de experimento, guardados porque registram *o que foi tentado, o que foi medido e
por que se decidiu assim* — o que evita repetir caminho já percorrido.

Regra: arquivo que entra aqui está **congelado**. Não se atualiza. Se o assunto
voltar a ser relevante, escreve-se documento novo (ou uma
[ADR](../decisoes/)), e o antigo continua como estava.

| Documento | O que registra | Época |
|---|---|---|
| [`super-orchestrator-model-experiments.md`](super-orchestrator-model-experiments.md) | Comparação de modelos e esforços de raciocínio para o orquestrador de turno; vereditos cegos. | jun–jul/2026 |
| [`gpt-5.6-model-poc.md`](gpt-5.6-model-poc.md) | Prova de conceito da família de modelos 5.6. | jul/2026 |
| [`diagnostico-cache-terra-jul2026.md`](diagnostico-cache-terra-jul2026.md) | Diagnóstico de falhas de cache de prefixo. | jul/2026 |
| [`oratia-benchmark-plan.md`](oratia-benchmark-plan.md) | Plano do benchmark de custo. | jul/2026 |
| [`oratia-benchmark-implementation-plan.md`](oratia-benchmark-implementation-plan.md) | Plano de implementação do mesmo benchmark. | jul/2026 |

## Ainda fora daqui

`docs/auth-multitenant-plan.md` é um plano, mas está **referenciado por código
vivo** (`auth.js`, `lib/cpf.js`, `lib/invites.js`) e por isso segue na pasta
principal. Quando o que ele descreve estiver todo em produção e documentado em
[`access-model.md`](../access-model.md), os ponteiros no código devem passar a
apontar para lá e o plano vem para cá.
