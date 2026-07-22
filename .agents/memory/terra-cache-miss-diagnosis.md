---
name: Diagnóstico de cache miss no gpt-5.6-terra
description: Como discriminar compactação × roteamento × TTL como causa de prompt cache miss no orquestrador (Responses + Conversations API)
---

Achados verificados (jul/2026, dados de prod + experimento controlado):

- **TTL não é a causa**: docs oficiais garantem ≥30 min de retenção no GPT-5.6+ (`prompt_cache_options.ttl:"30m"`); cache write é cobrado 1,25×.
- **Roteamento não é a causa**: probe controlado (prefixo determinístico ~9,4k tokens, `prompt_cache_key` fixo, intervalos de 45s a 5,5min, séries idêntica e crescente) acertou 100% do cache em todas as chamadas. Prefixo crescente grava só o sufixo novo (`cache_write_tokens` incremental).
- **Compactação server-side** (`context_management.compact_threshold`) explica APENAS os misses de fim de entrevista, quando o input encolhe entre turnos (assinatura: delta de input_tokens < 0). Nos modelos 5.4/5.5 o encolhimento nem correlaciona com miss.
- **Causa restante dos misses "tudo ou nada" no terra** (0% com prefixo crescendo normal): instabilidade na renderização server-side da conversa (Conversations API) entre turnos — algo reescreve itens no início do histórico (candidatos: itens de reasoning descartados de turnos antigos, resultados de file_search re-renderizados). Modelos 5.4/5.5 mostram misses parciais/graduais; terra é bimodal (0% ou >60%).

**Como reproduzir o probe**: script Node standalone (fora do repo), Responses API com `instructions` fixas grandes + `prompt_cache_key`, chamadas espaçadas rodando como workflow console (processos >120s morrem em bash background). Custo ~US$0,25.

**Assinatura no ledger** (`work_cost_events`): miss total = `cached_tokens=0`; compactação = `input_tokens` menor que o turno anterior na mesma submissão.
