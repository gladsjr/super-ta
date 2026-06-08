# Teste E2E do modo áudio

Harness que conduz uma entrevista inteira em **modo áudio**, ponta a ponta,
dirigindo o frontend real (`static/student.html`) num Chrome controlado com
**microfone falso**, enquanto um **simulador de aluno** (LLM) responde
dinamicamente a cada pergunta real do entrevistador.

## O que ele testa (e o que não testa)

✅ Testa: gravação no browser (`MediaRecorder`), upload, STT, super-orquestrador,
intro, pré-gate de inteligibilidade, TTS, SSE, reprodução de áudio, e a
renderização pelo lado do professor. Tudo com os modelos reais da conta.

❌ **Não** julga qualidade/naturalidade de voz — isso continua sendo ouvido
humano. O harness salva todos os `.mp3` (entrevistador e aluno) para auditoria.

## Como funciona o microfone falso

`inject.js` é injetado antes dos scripts da página e sobrescreve
`navigator.mediaDevices.getUserMedia` para devolver um `MediaStream` alimentado
por um `AudioContext`. A cada turno, `window.__superTASpeak(base64Mp3)` toca a
fala sintetizada do aluno nesse stream — o `MediaRecorder` da página grava
exatamente esse áudio. Sem microfone físico e **sem relançar o Chrome** entre
turnos.

O loop é **dinâmico**: o texto da pergunta do entrevistador é capturado da
resposta do `/chat` (campo `assistant`), o simulador gera a resposta do aluno
para *aquela* pergunta, sintetiza em voz e injeta. Perguntas dinâmicas não são
problema.

## Pré-requisitos

- Docker (Postgres) — o harness sobe sozinho se o servidor não estiver no ar.
- `.env` com `OPENAI_API_KEY`, `DATABASE_URL`, `INITIAL_USERS` (já presentes).
- `playwright-core` (devDependency) + Google Chrome instalado.

## Uso

```bash
npm run test:audio                         # persona padrão, 3 perguntas, headless
node tests/audio-e2e/run.mjs --headed      # vê o navegador conduzindo
node tests/audio-e2e/run.mjs --persona enrolando --voice ash --questions 4
node tests/audio-e2e/run.mjs --keep-server # não derruba o servidor que ele subiu
```

Personas de aluno disponíveis: `bem_preparado`, `enrolando`, `inseguro`
(ver `student.mjs`).

## Saída

Cada execução grava em `tests/audio-e2e/runs/<timestamp>/`:

- `report.json` — config, turnos (pergunta + resposta + fase + flags), erros.
- `transcript.md` — transcrição legível da entrevista.
- `professor-conversation.json` — o registro canônico pelo lado do professor.
- `audio/turnNN_entrevistador.mp3` e `audio/turnNN_aluno.mp3` — para você ouvir.

Exit code `0` = OK (entrevista finalizou, sem erros de página); `1` = revisar.

## Custo

Cada execução gasta tokens reais (STT + TTS + raciocínio). `--questions 3`
mantém o custo baixo. Aumente só quando precisar exercitar entrevistas longas.
