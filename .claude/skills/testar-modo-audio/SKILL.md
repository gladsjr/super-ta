---
name: testar-modo-audio
description: >-
  Roda o teste E2E do modo áudio do super-ta: conduz uma entrevista inteira no
  navegador (Playwright + microfone falso) com um simulador de aluno que responde
  dinamicamente, depois resume o resultado. Use SEMPRE que o usuário pedir para
  testar, simular, exercitar ou validar o modo áudio / a entrevista por voz —
  frases como "testa o modo áudio", "roda uma entrevista de teste", "simula um
  aluno", "faz um teste de voz", "testa a entrevista falada", "roda o teste de
  áudio", "vê se o áudio tá funcionando". Também quando o usuário acabou de mexer
  em algo de STT/TTS/orquestrador/intro e quer conferir o fluxo de voz ponta a
  ponta. NÃO use para o modo texto nem para julgar qualidade/naturalidade de voz
  (o harness não escuta — ele valida a cadeia funcional e salva os mp3 para o
  humano ouvir).
---

# Testar o modo áudio do super-ta

Dispara o harness E2E em `tests/audio-e2e/`, que dirige a `static/student.html`
num Chrome controlado com **microfone falso** e um **simulador de aluno** (LLM)
que responde, por voz, dinamicamente a cada pergunta real do entrevistador.
Exercita a cadeia inteira: gravar → STT → super-orquestrador → intro → pré-gate
de inteligibilidade → TTS → SSE → reprodução → finalize → arquivamento.

**Limitação honesta a comunicar ao usuário:** o harness valida o funcionamento,
não a qualidade da voz. Ele não escuta. Por isso salva todos os `.mp3` (do
entrevistador e do aluno) para auditoria humana. Não afirme que a voz "está boa".

## Passo 1 — SEMPRE perguntar os parâmetros antes de rodar

Antes de executar, pergunte ao usuário (via AskUserQuestion) os três parâmetros.
Nunca assuma defaults silenciosamente — o usuário pediu para sempre escolher.

- **Persona do aluno** (como o aluno se comporta):
  - `bem_preparado` — fez e entende o trabalho, cita números.
  - `enrolando` — leu por cima, vago, desvia de números.
  - `inseguro` — entende mas é tímido, hesita, respostas curtas.
- **Nº de perguntas** (inteiro 3–20). Sugira **3** para um teste rápido e barato;
  mais que isso só quando quiser exercitar entrevistas longas.
- **Voz do entrevistador** (TTS). Expressivas: `coral` (f), `ash` (m),
  `ballad` (m), `verse` (neutra), `marin` (f), `cedar` (m). Herdadas/locucionais:
  `alloy`, `shimmer`, `nova`, `echo`, `onyx`, `sage`.

## Passo 2 — Rodar o harness

A partir da raiz do projeto:

```bash
node tests/audio-e2e/run.mjs --persona <PERSONA> --voice <VOZ> --questions <N>
```

Notas operacionais:
- É **demorado** (gera/sintetiza/transcreve áudio a cada turno; ~5 min para 3
  perguntas, mais para entrevistas longas). Rode em background e monitore a saída
  até a linha `Relatorio:`. Não fique fazendo `sleep` curto em loop.
- O harness **reusa o servidor** se já houver um no ar em `127.0.0.1:5000`; senão,
  sobe Postgres (docker) + servidor sozinho. Use `127.0.0.1`, nunca `localhost`
  (o `fetch` do Node resolve `localhost` para IPv6 e o servidor escuta em IPv4).
- Cada execução cria um trabalho de teste no banco de dev. **NÃO apague** — o
  usuário quer mantê-los para inspeção no painel do professor.

## Ambiente de teste/prod (modo remoto) — quando NÃO for localhost

Quando o usuário pedir para testar o áudio **no ambiente de teste/dev ou em
produção** (não no localhost), use o **modo remoto**. Nesse modo o harness NÃO
sobe servidor nem cria trabalho: ele usa um trabalho **já configurado** (áudio)
e só cunha uma submissão pelo token, **sem login** (o endpoint
`POST /w/:workToken/submissions` é público — `requireWorkToken` não exige sessão).

Procedimento:
1. **Pergunte ao usuário a URL** (`--base`, ex.: a `.replit.dev` do dev, que muda
   a cada vez; ou a URL publicada) **e o token do TRABALHO** (`--work`) — de um
   trabalho já configurado em **modo áudio**.
2. Em modo remoto, **voz e nº de perguntas vêm da config do trabalho** — os flags
   `--voice/--questions` são ignorados. Então **pergunte só a persona**.
3. (Pré-flight opcional, barato) confirme que o trabalho é áudio:
   `POST <base>/w/<token>/submissions` → pega o `submission_token` → `POST
   <base>/s/<sub>/start` → confira `interactionMode == "audio"`.
4. Rode:
   ```bash
   node tests/audio-e2e/run.mjs --base <URL> --work <WORK_TOKEN> --persona <PERSONA>
   ```

Diferenças do modo local: sem servidor local, sem seed completo, e **sem
`professor-conversation.json`** no relatório (não há sessão de professor). O
veredito vem do lado do aluno (`report.json` + `transcript.md` + `audio/`).

**Ressalva honesta (do Replit):** o proxy do **dev (`.replit.dev`) difere do
publicado**. Então um teste no dev valida a **cadeia funcional** e a não-regressão
(ex.: o heartbeat do SSE não quebra nada), mas a **confirmação definitiva** de um
fix de **idle timeout** (turno longo >55s sobrevivendo) é na **URL publicada**.
Não trate "passou no dev" como "fix confirmado em prod".

## Passo 3 — Resumir o resultado

A execução grava em `tests/audio-e2e/runs/<timestamp>/`. Leia desse diretório:

- `report.json` — resuma: `ok`, nº de turnos, `finishedPhase` (esperado:
  `finalizing`/`finalized`), `pageErrors`, `consoleErrors`, e quantos turnos
  tiveram `audio_error` ou `intelligibility_gate`.
- `transcript.md` — a entrevista legível (pergunta + resposta por turno).
- `professor-conversation.json` — registro canônico do lado do professor
  (inclui os áudios do aluno arquivados).

No resumo ao usuário, inclua:
- Veredito: passou (`ok=true`, finalizou, sem `pageErrors`) ou revisar.
- Quantos turnos e a fase final.
- Qualquer `audio_error`, trava de inteligibilidade, ou erro de página/console
  — citando o turno. **Ignore como benigno** um `consoleError` de `410 (Gone)`:
  é um recurso de áudio buscado após a finalização, não um bug.
- O caminho da pasta `audio/` para o usuário **ouvir os mp3**, e o link do painel
  do professor: `http://127.0.0.1:5000/w/<work_token>` (o `work_token` aparece no
  log do seed e em `report.json` → `seed.workToken`).

## Quando algo falha

Se o harness sair com erro antes de finalizar, leia a saída e
`tests/audio-e2e/server.out.log` (se ele subiu o próprio servidor). Causas comuns
já tratadas no código: servidor não no ar, consentimento/“Ciente” não aceitos,
microfone falso. Para ver o navegador conduzindo (debug), rode com `--headed`.
