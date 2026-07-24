---
name: Diagnóstico de cache miss no gpt-5.6-terra
description: Causa dos prompt cache misses "tudo ou nada" no orquestrador (Responses + Conversations API) e como discriminar hipóteses
---

Achados verificados (jul/2026, dados de prod + 2 experimentos controlados):

- **Conversations API está INOCENTADA**: probe com Conversation real (6 turnos, terra, mesma chave, gaps 45s–2min) acertou 100% do cache; snapshots dos items entre turnos mostraram ZERO mudança retroativa no histórico (nenhum item removido/reescrito).
- **Prefixo instável inocentado em condições sintéticas**: probe com prefixo determinístico (idêntico e crescente), chave própria = 100% de hit até 5,5 min de gap. (Isso NÃO inocenta o roteamento nas condições de prod — ver abaixo.)
- **Compactação server-side** (`context_management.compact_threshold`) explica APENAS os misses com input encolhendo entre turnos (assinatura: delta de input_tokens < 0). Nos modelos 5.4/5.5 o encolhimento nem correlaciona com miss.
- **"Carga no pico" e "prefixo grande" REFUTADOS como causas por si (23/07):** probes NO PICO (19h30–20h20 BR) com prefixos de 27k E 80k tokens, histórico crescente, toques a cada 2,5 min = 94–98% de hit, zero miss (implícito e explícito). O cache da OpenAI aguenta pico + prefixo jumbo em condições sintéticas.
- **Assinatura decisiva: miss anômalo é TOTAL (cached=0), não parcial.** Drift de prefixo (ex.: compactação) dá hit PARCIAL (13–40%); cached=0 com primeiros tokens estáveis = a requisição caiu numa máquina SEM cache ⇒ ROTEAMENTO, não eviction. CUIDADO com padrões de janela estreita: olhando só 22–23/07 parecia "só ≥70k no pico"; o ledger completo mostra misses com input de 35–100k, gaps de 30 s a 5 min e em QUALQUER horário (inclusive 10h da manhã) — intermitente por requisição, sem correlação com tamanho/hora/gap.
- **Chave compartilhada + Conversations TAMBÉM inocentadas (probe v4, 23/07 no pico):** forma EXATA de prod (Conversations reais, instructions ~75k, context_management compaction, truncation:auto, effort medium, chave iv:* compartilhada por 2 "alunos" + agente intruso ~15k intercalado a 20s) = 89–98% de hit, zero miss total. A mistura de prefixos gigantes na mesma chave NÃO derruba o cache em vitro.
- **Conclusão operacional: diagnóstico em vitro ESGOTADO.** Toda forma sintética reproduz limpa; o miss anômalo 0% de prod é real porém raro e não-reproduzível de fora (restam: file_search no payload, tráfego real da org/flutuação interna da OpenAI, incidentes transitórios). Estratégia: parar de diagnosticar e mitigar — breakpoints explícitos (retenção estendida documentada) e/ou chave por submissão — monitorando o ledger.
- Cuidado com janelas de observação: "misses só no dia X" pode ser só "monitoramento criado no dia X" — checar desde quando a métrica existe antes de inferir evento.
- **Alavanca documentada não usada: cache breakpoints explícitos (5.6+)** — `prompt_cache_breakpoint {mode:"explicit"}` marca onde termina o prefixo cacheado; modo `explicit` em `prompt_cache_options` faz só o marcado ser escrito/cobrado (write 1,25×). Até 4 writes/chamada, leitura pelo prefixo mais longo (até 50 marcadores). Restrição: na Responses API o marcador só vai em blocos de input (input_text/file/image), NÃO no campo `instructions` — usar exigiria mover o conteúdo estável para a 1ª mensagem. `prompt_cache_key` é obrigatória no 5.6+ para matching confiável (já enviamos).

**Como reproduzir o probe**: script Node standalone (fora do repo), Responses API com `instructions` fixas grandes + `prompt_cache_key`, chamadas espaçadas rodando como workflow console (processos >120s morrem em bash background). Custo ~US$0,25 por série. Para testar eviction de verdade, rodar no horário de pico.

**Assinatura no ledger** (`work_cost_events`): miss total = `cached_tokens=0`; compactação = `input_tokens` menor que o turno anterior na mesma submissão.
