---
name: Diagnóstico de cache miss no gpt-5.6-terra
description: Causa dos prompt cache misses "tudo ou nada" no orquestrador (Responses + Conversations API) e como discriminar hipóteses
---

Achados verificados (jul/2026, dados de prod + 2 experimentos controlados):

- **Conversations API está INOCENTADA**: probe com Conversation real (6 turnos, terra, mesma chave, gaps 45s–2min) acertou 100% do cache; snapshots dos items entre turnos mostraram ZERO mudança retroativa no histórico (nenhum item removido/reescrito).
- **Roteamento e prefixo instável também inocentados**: probe com prefixo determinístico (idêntico e crescente) = 100% de hit até 5,5 min de gap.
- **Compactação server-side** (`context_management.compact_threshold`) explica APENAS os misses com input encolhendo entre turnos (assinatura: delta de input_tokens < 0). Nos modelos 5.4/5.5 o encolhimento nem correlaciona com miss.
- **Causa dominante dos misses 0% do terra: perda do cache sob carga (empírico).** Padrão nos dados: horário de pico (noite BR = tarde/noite EUA) com gaps de 1,5–4 min → misses em série; madrugada/gaps <1 min → quase tudo hit. Probabilístico (hit com gap 2:46, miss com 0:53). Probes ao meio-dia BR não reproduzem (carga baixa). ATENÇÃO: a doc oficial diz que ttl 30m já é o DEFAULT (e único valor) e promete retenção mínima de 30 min — os dados de pico CONTRADIZEM a doc; setar ttl explicitamente é inócuo.
- Intercalação de alunos na mesma `prompt_cache_key` (iv:workId) foi descartada: turnos de cada aluno são contíguos, sem sobreposição.
- **Alavanca documentada não usada: cache breakpoints explícitos (5.6+)** — `prompt_cache_breakpoint {mode:"explicit"}` marca onde termina o prefixo cacheado; modo `explicit` em `prompt_cache_options` faz só o marcado ser escrito/cobrado (write 1,25×). Até 4 writes/chamada, leitura pelo prefixo mais longo (até 50 marcadores). Restrição: na Responses API o marcador só vai em blocos de input (input_text/file/image), NÃO no campo `instructions` — usar exigiria mover o conteúdo estável para a 1ª mensagem. `prompt_cache_key` é obrigatória no 5.6+ para matching confiável (já enviamos).

**Como reproduzir o probe**: script Node standalone (fora do repo), Responses API com `instructions` fixas grandes + `prompt_cache_key`, chamadas espaçadas rodando como workflow console (processos >120s morrem em bash background). Custo ~US$0,25 por série. Para testar eviction de verdade, rodar no horário de pico.

**Assinatura no ledger** (`work_cost_events`): miss total = `cached_tokens=0`; compactação = `input_tokens` menor que o turno anterior na mesma submissão.
