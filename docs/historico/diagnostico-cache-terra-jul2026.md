# Diagnóstico dos cache misses no gpt-5.6-terra — relatório completo

**Período:** 20–24/07/2026 · **Sistema:** ORATIA (entrevistas de avaliação, FGV MBA 2026-07 Entrevista Cripto) · **Horários:** todos em GMT-3 (Rio de Janeiro).

---

## 1. Contexto e gatilho

Em 20/07/2026 o modelo principal da aplicação passou a ser o `gpt-5.6-terra` (configurado em `config/policy.yaml`). O orquestrador da entrevista (`SuperOrchestratorAgent`) faz **uma chamada de raciocínio por turno**, com um prompt que cresce ~8 mil tokens por turno (instruções fixas + histórico da conversa via Conversations API + o estado do turno). Esse desenho depende criticamente do **prompt cache** da OpenAI: a partir do 2º turno, ~90% do prompt deveria vir do cache (10% do preço).

O gatilho da investigação: o ledger de custos (`work_cost_events`) mostrou entrevistas reais com aproveitamento de cache muito abaixo do esperado — turnos inteiros com `cached_tokens = 0` mesmo com o turno anterior a 1–5 minutos de distância.

### Preços do terra (USD por milhão de tokens)

| Tipo | Preço |
|---|---|
| Input não cacheado | 2,50 |
| Input cacheado (hit) | 0,25 (10%) |
| Gravação de cache (write) | 3,125 (1,25× o input) |
| Output | 15,00 |

O detalhe que amplifica o prejuízo: cada miss não só perde o desconto de 90% — **paga a sobretaxa de 25% para regravar o prefixo inteiro**. (TTS `gpt-4o-mini-tts` e STT `gpt-4o-transcribe` não têm cache de prompt; são cobrados por caracteres/áudio.)

---

## 2. Cronologia da investigação (23–24/07)

1. **Observação inicial (23/07):** entrevista 149 (concluída 23/07 19h04) com apenas 40% de cache; olhando o ledger de 22–23/07, os misses pareciam concentrados em prompts ≥70k tokens e no horário de pico.
2. **Armadilha da janela de observação:** o "padrão" inicial ("só ≥70k", "só no pico") era artefato de olhar poucos dias. O ledger completo derrubou os dois (ver §5).
3. **Probes controlados (23/07, noite):** quatro experimentos sintéticos (v1–v4), todos com resultado LIMPO — nenhuma forma sintética reproduziu o miss.
4. **Análise fina de 153 e 170 (24/07):** abriu o quadro real — misses em qualquer tamanho (35k–106k), qualquer gap (30 s a 5,5 min), qualquer horário (inclusive 10h da manhã).
5. **Veredito:** o miss anômalo é intermitente, por requisição, do lado da OpenAI (assinatura de roteamento). Diagnóstico em vitro esgotado; a alavanca restante é mitigação (breakpoints explícitos do 5.6+).

---

## 3. Hipóteses cogitadas e o destino de cada uma

| # | Hipótese | Teste que a decidiu | Veredito |
|---|---|---|---|
| H-TTS | "Os eventos pequenos sem cache são falha" | Leitura da documentação de billing | **N/A** — TTS/STT não têm cache de prompt; os eventos de US$ 0,002–0,005 no ledger são áudio |
| H-compactação | Compactação server-side (`context_management.compact_threshold`) invalida o prefixo | Assinatura no ledger: input_tokens ENCOLHE vs turno anterior | **Confirmada, mas parcial** — explica só 6 dos 30 misses (os com encolhimento). É custo esperado do recurso |
| H-Conversations | A Conversations API reescreve o histórico retroativamente (quebrando o prefixo) | Probe v1: Conversation real, 6 turnos, snapshots dos items entre turnos | **Refutada** — 100% de hit; zero mudança retroativa nos items |
| H-prefixo-instável | Nosso código muda o começo do prompt entre turnos | Auditoria do `SuperOrchestratorAgent`: instructions fixas por entrevista (só MIN/MAX_TURNS, estáveis); TODO estado mutável (memory, agenda, plano, turno) vai no input NOVO de cada turno, no fim do prompt; `forceAdvanceDirective` vai deliberadamente no input, nunca nas instructions. Probe v2 (prefixo determinístico) = 100% hit | **Refutada** |
| H-expiração | Gaps entre turnos maiores que a vida do cache | Ledger: misses com gaps de 30–90 segundos (sub 170) | **Refutada** — cache vive minutos (~até 30 min); os gaps reais são 0,5–5,5 min |
| H1-prefixo-grande | Prompts de 70–100k tokens não cabem/não persistem no cache | Probe v3, braço A: prefixo de 80k tokens, histórico crescente, toques a cada 2,5 min | **Refutada** — 94–95% de hit |
| H3-pico | Carga no horário de pico evita o cache | Probe v3 rodado NO PICO (19h30–20h20 BR) | **Refutada** — 94–98% de hit, zero miss |
| H4-chave-compartilhada | Vários alunos na mesma `prompt_cache_key` (`iv:<workId>`) se atropelam | Probe v4: forma EXATA de prod — Conversations reais, instructions ~75k, 2 "alunos" com a MESMA chave + agente "intruso" de 15k intercalado a cada 20 s, compaction ligada, truncation:auto, effort medium, no pico | **Refutada em vitro** — 89–98% de hit, zero miss total (dump completo no §6) |
| H-retomada | As entrevistas em duas visitas (153, 170) teriam cache "envelhecido" | Extrato por evento: a visita do dia 1 foi SÓ a saudação (~US$ 0,05, sem prefixo grande); a entrevista inteira rodou em bloco contínuo no dia 2 | **Refutada** — correlação era coincidência; 153 foi cara porque teve 7 misses DENTRO do bloco contínuo |
| **H-roteamento** | A requisição cai numa máquina/partição sem o cache (lado OpenAI) | Assinatura: miss TOTAL (`cached=0`) com primeiros tokens comprovadamente estáveis. Drift de prefixo dá hit PARCIAL (13–40%); 0% absoluto num prompt de 35–106k = o cache não foi nem consultado com sucesso | **ÚNICA SOBREVIVENTE** — consistente com intermitência sem correlação com tamanho/hora/gap |

**Assinatura-chave que separa as classes de miss:**
- `cached_tokens = 0` com input CRESCENTE → miss anômalo (roteamento);
- `cached_tokens = 0` (ou parcial baixo) com input ENCOLHENDO → compactação server-side (esperado);
- hit parcial 13–40% → drift de prefixo (não observado fora da compactação).

---

## 4. Os quatro probes (23/07, ~US$ 1,30 no total)

Scripts Node standalone rodados como workflow (processos >120 s morrem em bash background no Replit). Última versão preservada em `.local/cache-probe4.mjs`; resultado bruto do v4 em `/tmp/cache_probe4_result.json`.

| Probe | Desenho | Resultado |
|---|---|---|
| v1 | Conversation real (Conversations API), terra, mesma chave, 6 turnos, gaps 45 s–2 min; snapshot dos items da conversa entre turnos para detectar reescrita retroativa | 100% de hit; zero mudança nos items |
| v2 | Prefixo determinístico (idêntico e crescente), chave própria, gaps de até 5,5 min | 100% de hit |
| v3 | NO PICO (19h30–20h20): braço A = prefixo 80k; braços B/C = 27k (cache implícito e explícito), histórico crescente, toques a cada 2,5 min | A: 94–95% · B/C: 98% · zero miss |
| v4 | Réplica exata de prod NO PICO: 2 "alunos" (S1/S2, instructions ~75k) + "intruso" P (15k) intercalado a cada ~20 s, TODOS na mesma `prompt_cache_key` compartilhada (`iv:probe4-*`), Conversations reais, compaction, truncation:auto, effort medium | 89–98% de hit; zero miss total |

### Dump do probe v4 (23/07 20h54 – 21h11 GMT-3)

| Hora | Braço | Turno | Input | Cached | Write | Hit % |
|---|---|---|---|---|---|---|
| 20:54:06 | S1 | 1 | 72.043 | 0 | 72.040 | (frio) |
| 20:54:27 | P | 1 | 15.447 | 0 | 15.444 | (frio) |
| 20:54:49 | S2 | 1 | 72.046 | 0 | 72.043 | (frio) |
| 20:57:21 | S1 | 2 | 73.748 | 71.538 | 1.705 | 97% |
| 20:57:42 | P | 2 | 15.418 | 13.682 | 1.725 | 89% |
| 20:58:04 | S2 | 2 | 73.820 | 71.538 | 1.774 | 97% |
| 21:00:36 | S1 | 3 | 75.455 | 73.586 | 1.707 | 98% |
| 21:00:57 | P | 3 | 15.431 | 13.682 | 1.738 | 89% |
| 21:01:19 | S2 | 3 | 75.538 | 73.586 | 1.718 | 97% |
| 21:03:51 | S1 | 4 | 77.186 | 75.122 | 1.731 | 97% |
| 21:04:12 | P | 4 | 15.449 | 13.682 | 1.756 | 89% |
| 21:04:34 | S2 | 4 | 77.270 | 75.122 | 1.732 | 97% |
| 21:07:06 | S1 | 5 | 78.962 | 77.170 | 1.776 | 98% |
| 21:07:28 | P | 5 | 15.408 | 13.682 | 1.715 | 89% |
| 21:07:50 | S2 | 5 | 78.974 | 77.170 | 1.704 | 98% |
| 21:10:23 | S1 | 6 | 80.693 | 78.706 | 1.731 | 98% |
| 21:10:46 | P | 6 | 15.407 | 13.682 | 1.714 | 89% |
| 21:11:07 | S2 | 6 | 80.695 | 78.706 | 1.721 | 98% |

Ou seja: a MESMA forma de requisição que em produção sofre misses, rodada de fora com dados sintéticos, funciona perfeitamente — inclusive com chave compartilhada e prefixos gigantes misturados. O que os probes não conseguem replicar: o tráfego real da org no momento, o `file_search` no payload e a "sorte" do roteamento interno da OpenAI.

---

## 5. As 9 entrevistas completas — dados de produção

Trabalho: **FGV MBA 2026-07 Entrevista Cripto** · modo áudio · nenhuma é teste. Fonte: tabela `work_cost_events` do banco de produção (consultas no §8). Além destas, houve 4 inícios abandonados (~US$ 0,05 cada) e 1 prova oral (fora deste ledger), não incluídos.

### 5.1 Resumo

| Sub | Aluno(a) | Entrevista (bloco real) | Turnos | Custo total | Input total | Cache total | Cache % | Misses anômalos |
|---|---|---|---|---|---|---|---|---|
| 153 | Paula Furlan Palhares | 21/07 19h46–20h19 | 11 | **US$ 2,3768** | 862.049 | 136.932 | 16% | **7** |
| 170 | Isabella Rodrigues Soares | 22/07 09h50–10h01 | 8 | **US$ 1,8308** | 629.524 | 100.119 | 16% | **4** |
| 149 | Diego Fernandes Reis | 23/07 18h37–19h04 | 10 | **US$ 1,6265** | 755.738 | 302.022 | 40% | 3 |
| 165 | Lucas Rastelle Ferreira | 21/07 20h34–21h00 | 8 | **US$ 1,6123** | 625.287 | 171.472 | 27% | 4 |
| 161 | Johan Lemes dos Santos | 22/07 21h34–21h53 | 8 | **US$ 1,4324** | 542.579 | 145.286 | 27% | 3 |
| 147 | George de Assunção Narciso | 21/07 23h43–00h18 | 10 | **US$ 1,2663** | 675.967 | 349.243 | 52% | 2 |
| 154 | Rebeca Gentile | 22/07 19h23–19h33 | 8 | **US$ 1,2625** | 621.056 | 322.388 | 52% | **0** |
| 143 | Matheus Bernardi da Silva | 22/07 16h47–17h06 | 9 | **US$ 1,2260** | 661.840 | 377.043 | 57% | **0** |
| 160 | Lucas Leite Kogus | 21/07 23h37–23h46 | 5 | **US$ 0,7363** | 305.599 | 139.637 | 46% | 1 |

**Total: US$ 13,37 · média US$ 1,49** (faixa 0,74–2,38). Observações:
- 153 e 170 tiveram uma visita prévia noutro dia (só a saudação, ~US$ 0,05); a entrevista em si foi contínua.
- 154 e 170 constam como `give_up` (aluna encerrou por desistência no fluxo), as demais `complete`.
- A correlação custo × misses é direta: as duas com 16% de cache são as mais caras.

### 5.2 Balanço das 77 chamadas do orquestrador

| Classe | Qtde | Interpretação |
|---|---|---|
| 1º turno (frio, esperado) | 9 | Sem prefixo anterior — paga write integral |
| **Hit normal** | **38** | 82–99% do prompt no cache |
| **Miss anômalo (cached=0, input crescente)** | **24** | A anomalia investigada — deveria ter sido hit |
| Miss por compactação (input encolheu) | 6 | Custo esperado do `compact_threshold` |

Ou seja: **35% dos turnos que deveriam acertar o cache (24 de 68) falharam totalmente.**

As 18 chamadas do PrepBuilder (2 por entrevista: analyzeWork + buildPlan) são sempre frias por natureza (prompt único), somando US$ 3,04 do total.

### 5.3 Extrato turno a turno (gpt-5.6-terra, todas as 95 chamadas)

Colunas: hora (GMT-3), agente, input, cached, não-cacheado, output, custo (US$), classificação.
Classificação: FRIO = 1ª chamada; HIT; **MISS!** = anômalo (cached=0 com input crescente); COMPACT = miss/parcial com input encolhendo (compactação server-side).

#### Sub 143 — Matheus (22/07) · 0 misses anômalos · a entrevista "como deveria ser"

| Hora | Agente | Input | Cached | Não-cach. | Out | US$ | Classe |
|---|---|---|---|---|---|---|---|
| 16:47:05 | PrepBuilder:analyzeWork | 32.892 | 0 | 32.892 | 2.291 | 0,1372 | FRIO |
| 16:47:24 | PrepBuilder:buildPlan | 37.890 | 0 | 37.890 | 1.908 | 0,1470 | FRIO |
| 16:56:51 | SuperOrchestrator | 14.690 | 0 | 14.690 | 484 | 0,0531 | FRIO |
| 16:57:52 | SuperOrchestrator | 35.292 | 14.194 | 21.098 | 488 | 0,0765 | HIT |
| 16:58:42 | SuperOrchestrator | 42.702 | 35.263 | 7.439 | 615 | 0,0413 | HIT |
| 16:59:55 | SuperOrchestrator | 63.909 | 42.354 | 21.555 | 307 | 0,0823 | HIT |
| 17:00:40 | SuperOrchestrator | 71.159 | 63.858 | 7.301 | 561 | 0,0472 | HIT |
| 17:02:27 | SuperOrchestrator | 79.054 | 71.130 | 7.924 | 990 | 0,0574 | HIT |
| 17:03:59 | SuperOrchestrator | 103.419 | 78.706 | 24.713 | 505 | 0,1045 | HIT |
| 17:05:40 | SuperOrchestrator | 71.854 | 0 | 71.854 | 1.230 | 0,2430 | COMPACT (103k→72k) |
| 17:06:24 | SuperOrchestrator | 93.816 | 71.538 | 22.278 | 505 | 0,0949 | HIT |

#### Sub 147 — George (21→22/07, virada de meia-noite) · 2 misses anômalos

| Hora | Agente | Input | Cached | Não-cach. | Out | US$ | Classe |
|---|---|---|---|---|---|---|---|
| 23:43:13 | PrepBuilder:analyzeWork | 30.779 | 0 | 30.779 | 2.088 | 0,1275 | FRIO |
| 23:43:32 | PrepBuilder:buildPlan | 35.805 | 0 | 35.805 | 1.965 | 0,1414 | FRIO |
| 00:08:59 | SuperOrchestrator | 14.894 | 0 | 14.894 | 579 | 0,0552 | FRIO |
| 00:09:49 | SuperOrchestrator | 31.207 | 14.706 | 16.501 | 554 | 0,0634 | HIT |
| 00:10:27 | SuperOrchestrator | 38.853 | 31.090 | 7.763 | 289 | 0,0363 | HIT |
| 00:11:09 | SuperOrchestrator | 46.233 | 38.770 | 7.463 | 541 | 0,0411 | HIT |
| 00:13:10 | SuperOrchestrator | 53.983 | 0 | 53.983 | 358 | 0,1451 | **MISS!** (gap 2 min) |
| 00:13:59 | SuperOrchestrator | 61.561 | 53.618 | 7.943 | 576 | 0,0466 | HIT |
| 00:14:51 | SuperOrchestrator | 69.292 | 61.298 | 7.994 | 428 | 0,0466 | HIT |
| 00:15:59 | SuperOrchestrator | 76.969 | 69.263 | 7.706 | 884 | 0,0546 | HIT |
| 00:16:49 | SuperOrchestrator | 93.801 | 76.658 | 17.143 | 413 | 0,0787 | HIT |
| 00:18:12 | SuperOrchestrator | 104.184 | 0 | 104.184 | 490 | 0,3044 | **MISS!** (gap 83 s) |

#### Sub 149 — Diego (23/07, a que disparou a investigação) · 3 misses anômalos

| Hora | Agente | Input | Cached | Não-cach. | Out | US$ | Classe |
|---|---|---|---|---|---|---|---|
| 18:37:52 | PrepBuilder:analyzeWork | 37.835 | 0 | 37.835 | 2.310 | 0,1529 | FRIO |
| 18:38:20 | PrepBuilder:buildPlan | 42.874 | 0 | 42.874 | 2.072 | 0,1651 | FRIO |
| 18:47:45 | SuperOrchestrator | 15.082 | 0 | 15.082 | 487 | 0,0544 | FRIO |
| 18:48:49 | SuperOrchestrator | 34.784 | 0 | 34.784 | 592 | 0,1081 | **MISS!** (gap 64 s) |
| 18:51:08 | SuperOrchestrator | 42.710 | 34.755 | 7.955 | 597 | 0,0425 | HIT |
| 18:51:46 | SuperOrchestrator | 62.197 | 42.354 | 19.843 | 594 | 0,0813 | HIT |
| 18:52:58 | SuperOrchestrator | 70.076 | 61.810 | 8.266 | 655 | 0,0509 | HIT |
| 18:55:07 | SuperOrchestrator | 77.895 | 0 | 77.895 | 367 | 0,2050 | **MISS!** (gap 2 min) |
| 18:55:46 | SuperOrchestrator | 85.450 | 77.682 | 7.768 | 460 | 0,0505 | HIT |
| 18:57:05 | SuperOrchestrator | 98.129 | 85.421 | 12.708 | 691 | 0,0683 | HIT |
| 18:59:19 | SuperOrchestrator | 81.935 | 0 | 81.935 | 671 | 0,2661 | COMPACT (98k→82k) |
| 19:04:51 | SuperOrchestrator | 90.150 | 0 | 90.150 | 572 | 0,2390 | **MISS!** (gap 5,5 min) |

#### Sub 153 — Paula (21/07, a mais cara) · 7 misses anômalos em 10 turnos elegíveis

| Hora | Agente | Input | Cached | Não-cach. | Out | US$ | Classe |
|---|---|---|---|---|---|---|---|
| 19:46:23 | PrepBuilder:analyzeWork | 51.149 | 0 | 51.149 | 2.616 | 0,1991 | FRIO |
| 19:46:46 | PrepBuilder:buildPlan | 56.237 | 0 | 56.237 | 2.184 | 0,2085 | FRIO |
| 19:52:33 | SuperOrchestrator | 15.423 | 0 | 15.423 | 875 | 0,0613 | FRIO |
| 19:54:24 | SuperOrchestrator | 35.585 | 0 | 35.585 | 395 | 0,1074 | **MISS!** (gap 111 s) |
| 19:57:32 | SuperOrchestrator | 43.798 | 0 | 43.798 | 585 | 0,1233 | **MISS!** (gap 3 min) |
| 20:01:37 | SuperOrchestrator | 51.936 | 0 | 51.936 | 455 | 0,1417 | **MISS!** (gap 4 min) |
| 20:04:42 | SuperOrchestrator | 59.993 | 0 | 59.993 | 803 | 0,1670 | **MISS!** (gap 3 min) |
| 20:10:00 | SuperOrchestrator | 69.182 | 59.762 | 9.420 | 540 | 0,0523 | HIT |
| 20:12:10 | SuperOrchestrator | 77.407 | 0 | 77.407 | 700 | 0,2091 | **MISS!** (gap 2 min) |
| 20:14:52 | SuperOrchestrator | 85.946 | 77.170 | 8.776 | 654 | 0,0564 | HIT |
| 20:17:03 | SuperOrchestrator | 94.383 | 0 | 94.383 | 803 | 0,2532 | **MISS!** (gap 2 min) |
| 20:19:09 | SuperOrchestrator | 106.335 | 0 | 106.335 | 623 | 0,3148 | **MISS!** (gap 2 min) |
| 20:19:42 | SuperOrchestrator | 93.074 | 0 | 93.074 | 449 | 0,2976 | COMPACT (106k→93k) |

Nota: misses em inputs de 35k, 43k, 52k e 60k — foi este extrato que derrubou o "padrão ≥70k".

#### Sub 154 — Rebeca (22/07) · 0 misses anômalos

| Hora | Agente | Input | Cached | Não-cach. | Out | US$ | Classe |
|---|---|---|---|---|---|---|---|
| 19:23:58 | PrepBuilder:analyzeWork | 52.689 | 0 | 52.689 | 2.841 | 0,2073 | FRIO |
| 19:24:24 | PrepBuilder:buildPlan | 57.887 | 0 | 57.887 | 2.571 | 0,2195 | FRIO |
| 19:27:15 | SuperOrchestrator | 14.812 | 0 | 14.812 | 718 | 0,0570 | FRIO |
| 19:28:03 | SuperOrchestrator | 36.585 | 14.783 | 21.802 | 1.013 | 0,0870 | HIT |
| 19:28:56 | SuperOrchestrator | 58.572 | 36.556 | 22.016 | 898 | 0,0914 | HIT |
| 19:29:44 | SuperOrchestrator | 80.185 | 58.226 | 21.959 | 745 | 0,0941 | HIT |
| 19:30:49 | SuperOrchestrator | 91.683 | 80.156 | 11.527 | 808 | 0,0659 | HIT |
| 19:31:33 | SuperOrchestrator | 58.740 | 7.538 | 51.202 | 703 | 0,1724 | COMPACT (92k→59k, hit parcial) |
| 19:32:21 | SuperOrchestrator | 66.656 | 58.711 | 7.945 | 724 | 0,0503 | HIT |
| 19:33:46 | SuperOrchestrator | 89.156 | 66.418 | 22.738 | 658 | 0,0974 | HIT |

#### Sub 160 — Lucas K. (21/07, a mais curta) · 1 miss anômalo

| Hora | Agente | Input | Cached | Não-cach. | Out | US$ | Classe |
|---|---|---|---|---|---|---|---|
| 23:37:04 | PrepBuilder:analyzeWork | 26.008 | 0 | 26.008 | 2.644 | 0,1209 | FRIO |
| 23:37:26 | PrepBuilder:buildPlan | 31.610 | 0 | 31.610 | 2.178 | 0,1314 | FRIO |
| 23:42:44 | SuperOrchestrator | 15.561 | 0 | 15.561 | 921 | 0,0624 | FRIO |
| 23:43:48 | SuperOrchestrator | 38.512 | 0 | 38.512 | 620 | 0,1198 | **MISS!** (gap 64 s) |
| 23:44:24 | SuperOrchestrator | 46.766 | 38.258 | 8.508 | 499 | 0,0435 | HIT |
| 23:45:39 | SuperOrchestrator | 55.090 | 46.737 | 8.353 | 923 | 0,0516 | HIT |
| 23:46:39 | SuperOrchestrator | 78.062 | 54.642 | 23.420 | 500 | 0,0941 | HIT |

#### Sub 161 — Johan (22/07) · 3 misses anômalos

| Hora | Agente | Input | Cached | Não-cach. | Out | US$ | Classe |
|---|---|---|---|---|---|---|---|
| 21:34:34 | PrepBuilder:analyzeWork | 25.983 | 0 | 25.983 | 2.626 | 0,1206 | FRIO |
| 21:34:58 | PrepBuilder:buildPlan | 31.191 | 0 | 31.191 | 2.346 | 0,1327 | FRIO |
| 21:42:31 | SuperOrchestrator | 15.284 | 0 | 15.284 | 510 | 0,0554 | FRIO |
| 21:43:16 | SuperOrchestrator | 36.586 | 15.218 | 21.368 | 492 | 0,0779 | HIT |
| 21:44:53 | SuperOrchestrator | 44.756 | 0 | 44.756 | 321 | 0,1217 | **MISS!** (gap 97 s) |
| 21:46:04 | SuperOrchestrator | 52.566 | 0 | 52.566 | 587 | 0,1450 | **MISS!** (gap 71 s) |
| 21:47:44 | SuperOrchestrator | 60.918 | 0 | 60.918 | 577 | 0,1661 | **MISS!** (gap 100 s) |
| 21:49:39 | SuperOrchestrator | 69.208 | 60.889 | 8.319 | 818 | 0,0535 | HIT |
| 21:52:25 | SuperOrchestrator | 97.701 | 69.179 | 28.522 | 1.004 | 0,1174 | HIT |
| 21:53:28 | SuperOrchestrator | 92.624 | 0 | 92.624 | 424 | 0,2958 | COMPACT (98k→93k) |

#### Sub 165 — Lucas R. (21/07) · 4 misses anômalos

| Hora | Agente | Input | Cached | Não-cach. | Out | US$ | Classe |
|---|---|---|---|---|---|---|---|
| 20:34:16 | PrepBuilder:analyzeWork | 35.223 | 0 | 35.223 | 3.205 | 0,1581 | FRIO |
| 20:34:36 | PrepBuilder:buildPlan | 40.722 | 0 | 40.722 | 2.188 | 0,1601 | FRIO |
| 20:45:50 | SuperOrchestrator | 15.727 | 0 | 15.727 | 812 | 0,0613 | FRIO |
| 20:47:53 | SuperOrchestrator | 38.665 | 0 | 38.665 | 454 | 0,1177 | **MISS!** (gap 2 min) |
| 20:49:46 | SuperOrchestrator | 46.929 | 38.636 | 8.293 | 744 | 0,0467 | HIT |
| 20:50:26 | SuperOrchestrator | 69.156 | 46.450 | 22.706 | 690 | 0,0926 | HIT |
| 20:54:25 | SuperOrchestrator | 77.827 | 0 | 77.827 | 638 | 0,2095 | **MISS!** (gap 4 min) |
| 20:56:23 | SuperOrchestrator | 86.494 | 0 | 86.494 | 492 | 0,2289 | **MISS!** (gap 2 min) |
| 20:58:10 | SuperOrchestrator | 94.984 | 86.386 | 8.598 | 821 | 0,0607 | HIT |
| 21:00:45 | SuperOrchestrator | 104.978 | 0 | 104.978 | 2.953 | 0,3471 | **MISS!** (gap 2,5 min) |

#### Sub 170 — Isabella (22/07, manhã) · 4 misses anômalos

| Hora | Agente | Input | Cached | Não-cach. | Out | US$ | Classe |
|---|---|---|---|---|---|---|---|
| 09:50:58 | PrepBuilder:analyzeWork | 66.651 | 0 | 66.651 | 2.697 | 0,2487 | FRIO |
| 09:51:22 | PrepBuilder:buildPlan | 72.049 | 0 | 72.049 | 2.254 | 0,2590 | FRIO |
| 09:54:40 | SuperOrchestrator | 15.500 | 0 | 15.500 | 936 | 0,0625 | FRIO |
| 09:56:12 | SuperOrchestrator | 38.156 | 0 | 38.156 | 278 | 0,1136 | **MISS!** (gap 92 s) |
| 09:57:05 | SuperOrchestrator | 46.071 | 0 | 46.071 | 458 | 0,1269 | **MISS!** (gap 53 s) |
| 09:57:52 | SuperOrchestrator | 54.106 | 46.042 | 8.064 | 659 | 0,0466 | HIT |
| 09:58:36 | SuperOrchestrator | 76.652 | 54.077 | 22.575 | 847 | 0,0968 | HIT |
| 09:59:59 | SuperOrchestrator | 99.637 | 0 | 99.637 | 603 | 0,3195 | **MISS!** (gap 83 s) |
| 10:00:26 | SuperOrchestrator | 69.156 | 0 | 69.156 | 425 | 0,2225 | COMPACT (100k→69k) |
| 10:01:23 | SuperOrchestrator | 77.295 | 0 | 77.295 | 435 | 0,2048 | **MISS!** (gap 57 s) |

Nota: misses com gaps de 53–92 segundos, às 10h da manhã (fora de qualquer pico). Foi este extrato que derrubou o "padrão só no pico".

### 5.4 Custos por modelo, por entrevista (US$)

| Sub | terra (orquestrador+prep) | TTS (gpt-4o-mini-tts) | STT (gpt-4o-transcribe) | mini (Introduction etc.) | Total |
|---|---|---|---|---|---|
| 143 | 1,0843 (11 ch.) | 0,1180 (26 ch., 4.718 chars) | 0,0133 (11 ch.) | 0,0105 | 1,2260 |
| 147 | 1,1410 (12) | 0,1073 (27, 4.292) | 0,0067 (13) | 0,0113 | 1,2663 |
| 149 | 1,4840 (12) | 0,1124 (27, 4.494) | 0,0198 (12) | 0,0104 | 1,6265 |
| 153 | 2,1916 (13) | 0,1303 (31, 5.213) | 0,0442 (13) | 0,0107 | 2,3768 |
| 154 | 1,1424 (10) | 0,1029 (21, 4.116) | 0,0067 (10) | 0,0105 | 1,2625 |
| 160 | 0,6238 (7) | 0,0946 (17, 3.785) | 0,0074 (7) | 0,0105 | 0,7363 |
| 161 | 1,2861 (10) | 0,1185 (25, 4.740) | 0,0174 (10) | 0,0104 | 1,4324 |
| 165 | 1,4828 (10) | 0,1088 (24, 4.351) | 0,0102 (10) | 0,0106 | 1,6123 |
| 170 | 1,7007 (10) | 0,1108 (24, 4.431) | 0,0087 (10) | 0,0105 | 1,8308 |

O terra responde por 88–92% do custo; TTS+STT+mini são ~US$ 0,13 por entrevista. O `gpt-5.4-mini` cobre a fase de introdução (3 chamadas fixas) e, quando necessário, o pré-gate de inteligibilidade de áudio (ex.: 147).

---

## 6. Impacto financeiro dos misses anômalos

- Os 24 misses anômalos reprocessaram **~1,60 milhão de tokens** que deveriam ter vindo do cache (10% do preço) e ainda pagaram a sobretaxa de gravação.
- Custo extra estimado: **~US$ 3,80 no total** (≈28% do custo de todo o terra nas 9 entrevistas), distribuído de forma muito desigual — só a entrevista 153 carrega ~US$ 1,10 disso.
- Em regime de cache saudável (~90%+, como nos probes), a entrevista média cairia de US$ 1,49 para ~US$ 1,05–1,10; numa turma de 40 alunos, os misses custam ~US$ 15–17 por rodada.
- Os 6 misses de compactação (~US$ 0,9 extra) são o preço do `compact_threshold` — esperados e aceitáveis (a alternativa seria estourar contexto).

---

## 7. Veredito e próximo passo

**Veredito:** o miss anômalo é **intermitente, por requisição, sem correlação com tamanho do prompt, horário ou gap entre turnos** — e nenhuma forma sintética o reproduz. A assinatura (0% absoluto com prefixo estável, em vez de hit parcial) aponta para **roteamento interno da OpenAI** (a requisição cai numa máquina/partição que não tem o prefixo). Não há bug do nosso lado identificado; já enviamos `prompt_cache_key` estável por trabalho, as instructions são estáveis por entrevista e o histórico é append-only.

**Mitigação planejada (não aplicada ainda):** os **cache breakpoints explícitos** do 5.6+ (`prompt_cache_breakpoint`, modo `explicit`) — retenção estendida documentada e gravação apenas do trecho marcado. Restrição técnica: na Responses API o marcador só pode ir em blocos de input (não no campo `instructions`), o que exigiria mover o conteúdo estável para a 1ª mensagem do input. Decisão pendente: implementar e medir uma rodada A/B no ledger.

**Alternativa descartada:** trocar a chave para por-submissão (`iv:<submissionId>`) — o probe v4 mostrou que a chave compartilhada não é o problema.

---

## 8. Fontes de verificação

- **Ledger:** tabela `work_cost_events` (produção). Colunas relevantes: `submission_id`, `agent_label`, `model`, `input_tokens`, `cached_tokens`, `output_tokens`, `audio_seconds`, `audio_chars`, `cost_usd`, `created_at` (UTC — subtrair 3h).
- Consulta do extrato terra por entrevista:
  ```sql
  SELECT submission_id, created_at - interval '3 hours' AS hora_gmt3, agent_label,
         input_tokens, cached_tokens, output_tokens, cost_usd
  FROM work_cost_events
  WHERE submission_id IN (143,147,149,153,154,160,161,165,170)
    AND model = 'gpt-5.6-terra'
  ORDER BY submission_id, created_at;
  ```
- Consulta dos totais: mesma tabela, `GROUP BY submission_id` somando `cost_usd`, `input_tokens`, `cached_tokens`.
- **Assinaturas no ledger:** miss total = `cached_tokens = 0` com `input_tokens` maior que o turno anterior da mesma submissão; compactação = `input_tokens` MENOR que o turno anterior.
- **Probes:** script v4 em `.local/cache-probe4.mjs` (parametrizado; roda como workflow); resultado bruto em `/tmp/cache_probe4_result.json` (efêmero — dados completos transcritos no §4).
- **Metadados das entrevistas:** tabela `submissions` (produção) — `student_label`, `completed_at`, `completion_reason`, `frozen_interaction_mode`, `is_test`.
- **Memória do diagnóstico:** `.agents/memory/terra-cache-miss-diagnosis.md` (resumo operacional para sessões futuras).
