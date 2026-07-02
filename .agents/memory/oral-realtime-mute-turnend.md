---
name: Prova oral — examinador "muda" / clean=false
description: Diagnóstico do sintoma "a prova oral parou, examinador ficou mudo, tela vermelha 'Conexão encerrada'" e a tensão de configuração do VAD que o causa.
---

# Prova oral: examinador "muda" e sessão cai (clean=false)

## Sintoma
Durante a prova oral (Realtime), a examinadora faz uma pergunta, o aluno responde, e o
examinador **fica mudo** (não reconhece nem responde). A sessão fica parada e a conexão
cai; o frontend mostra o estado vermelho **"Conexão encerrada"**. Log do servidor:
`[ORAL_RELAY] bridge closed ... clean=false`.

## Como diagnosticar SÓ pelo servidor (sem console do navegador)
- `clean=false` ⇒ o aluno **nunca mandou `bye`** ⇒ NÃO foi o encerramento limpo. O caminho
  limpo mostraria "✓ Prova encerrada" no frontend, não a tela vermelha.
- Puxe a transcrição salva (`submissions.oral_transcript`). Se ela **termina numa pergunta
  do examinador e falta a resposta do aluno àquela pergunta**, e não há fala do examinador
  depois — então a **detecção de turno não fez o commit** do turno do aluno: sem commit não
  há transcrição do aluno E não dispara o `response.create` automático ⇒ examinador mudo.
- Isso NÃO é "o modelo esqueceu de chamar `encerrar_prova`" — esse caminho loga
  `encerrar_prova aceito` ou `... cedo demais`. Se nenhum desses aparece, a prova travou
  ANTES do encerramento, no reconhecimento do fim da última resposta.

## Raiz (tensão de produto, não bug de código)
`turn_detection: { type: "semantic_vad", eagerness: "low", ... }` + `noise_reduction:
far_field` (em `lib/oralRealtime.js`) é calibrado para ser **paciente**: evita cortar o
aluno no meio da fala e evita barge-in falso por ruído. O preço é o oposto — se o fim da
fala do aluno vem baixo/arrastado, o VAD pode **esperar demais e nunca fechar o turno**,
deixando o examinador esperando para sempre até a conexão cair.

## Impacto
- Bom: `clean=false` ⇒ `markOralExamCompleted` NÃO roda ⇒ a tentativa **não é consumida**,
  o aluno pode reabrir e refazer. Custo, transcrição e sinais de voz ficam salvos.
- Ruim: prova não concluída e, na queda anormal, o **vídeo gravado não é enviado** —
  `finish()`/`uploadVideo` só rodam no caminho limpo; o `ws.onclose` anormal só pinta o erro.

## Direção de correção (quando pedido)
Rede de segurança no servidor (nunca ficar pendurado): se após o áudio do aluno não houver
resposta em T segundos, forçar commit do buffer / cutucar `response.create`; e/ou um
wrap-up autoritativo do servidor em vez de depender só do modelo chamar `encerrar_prova`.
Além disso, salvar o vídeo mesmo em fecho anormal. **Gladstone declinou a correção em
2026-07-02 — só quis o diagnóstico.** Paliativo para testes: pausa clara / "terminei"
ajuda o VAD a fechar o turno.
