# 0002 — Falhar explícito, sem fallback arquitetural

> **Estado:** Aceita
> **Data:** 2026-06 (registrada em 2026-08-15)

## Contexto

Hierarquias de configuração com valor padrão embutido ("se não achar, usa
tal modelo") tornam o comportamento do sistema impossível de prever a partir da
configuração. Num produto onde a escolha de modelo muda custo e nota, um padrão
silencioso é uma decisão de negócio tomada por acidente.

## Decisão

Componentes críticos falham rápido. Seleção de modelo vem **apenas** de
`config/policy.yaml`. Configuração obrigatória ausente derruba o boot em vez de
adivinhar. Erros são retorno de informação, não algo a esconder.

## Consequências

- Um esquecimento de configuração vira indisponibilidade, não um comportamento
  errado e silencioso. É o troco que se aceita de propósito.
- Todo valor de configuração novo precisa de validação no boot.
- Preço de modelo entra na mesma regra: modelo sem preço configurado derruba o
  boot, porque a alternativa é contabilizar zero — o que já aconteceu por um mês.
