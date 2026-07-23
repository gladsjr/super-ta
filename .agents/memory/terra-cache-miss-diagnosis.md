---
name: Diagnóstico de cache miss no gpt-5.6-terra
description: Causa dos prompt cache misses "tudo ou nada" no orquestrador (Responses + Conversations API) e como discriminar hipóteses
---

Achados verificados (jul/2026, dados de prod + 2 experimentos controlados):

- **Conversations API está INOCENTADA**: probe com Conversation real (6 turnos, terra, mesma chave, gaps 45s–2min) acertou 100% do cache; snapshots dos items entre turnos mostraram ZERO mudança retroativa no histórico (nenhum item removido/reescrito).
- **Roteamento e prefixo instável também inocentados**: probe com prefixo determinístico (idêntico e crescente) = 100% de hit até 5,5 min de gap.
- **Compactação server-side** (`context_management.compact_threshold`) explica APENAS os misses com input encolhendo entre turnos (assinatura: delta de input_tokens < 0). Nos modelos 5.4/5.5 o encolhimento nem correlaciona com miss.
- **Causa dominante dos misses 0% do terra: EVICTION sob carga.** O retention de ≥30 min do GPT-5.6+ é OPT-IN via `prompt_cache_options: {ttl: "30m"}` — e o código NÃO envia essa opção; o default é best-effort (minutos, despejado sob carga). Padrão nos dados: entrevistas no horário de pico (noite BR = tarde/noite EUA) com gaps de 1,5–4 min entre turnos → misses em série; entrevistas de madrugada/gaps <1 min → quase tudo hit. Probabilístico (houve hit com gap 2:46 e miss com 0:53). Probes rodados ao meio-dia BR não reproduzem (carga baixa).
- Intercalação de alunos na mesma `prompt_cache_key` (iv:workId) foi descartada: turnos de cada aluno são contíguos, sem sobreposição.
- **Correção óbvia (não aplicada; sessão era só diagnóstico)**: adicionar `prompt_cache_options: { ttl: "30m" }` no payload do orquestrador; cache write já é cobrado 1,25× de qualquer forma.

**Como reproduzir o probe**: script Node standalone (fora do repo), Responses API com `instructions` fixas grandes + `prompt_cache_key`, chamadas espaçadas rodando como workflow console (processos >120s morrem em bash background). Custo ~US$0,25 por série. Para testar eviction de verdade, rodar no horário de pico.

**Assinatura no ledger** (`work_cost_events`): miss total = `cached_tokens=0`; compactação = `input_tokens` menor que o turno anterior na mesma submissão.
