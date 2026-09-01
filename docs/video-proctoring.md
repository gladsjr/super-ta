# Video proctoring ("fiscalização") on the message interview — detail

> Extraído do `replit.md` em 25/07/2026 para mantê-lo enxuto. Este arquivo é a fonte de detalhe da fiscalização por vídeo da entrevista; atualize AQUI quando ela mudar.

The message interview (default kind) can run with **camera-on video proctoring** — professor-facing label **"fiscalização por vídeo"** (opt-in per work, `works.proctoring_enabled`), reusing the oral exam's proctoring core **without touching the oral code**. Enabling it implies **audio mode** (spoken answers): the student sits ~1.5 m from the camera and commands the turn by **on-screen COMMAND AREAS** (a hand held in a corner box for a 1‑2‑3 count), **not** by button and **not** by gesture recognition. (An earlier gesture-recognition scheme was replaced after live testing — corner areas proved far more robust; the gesture code was removed.)

- **Student flow** (`static/js/commandZones.js` + `static/js/interviewSetup.js`, loaded by `static/student.html`; interview-only, no CDN; `gestureControl.js` was deleted). On "Enviar", the PDF **upload/analysis runs in parallel** while the student immediately enters a **3-stage setup**: (1) connection ping + noise meter + **speech calibration** (reads a sentence, scored server-side by the SAME `gpt-4o-transcribe` via `POST /s/:t/calibrate`, `lib/speechCalib.js`; sentence in `works.oral_calibration_json`, from the enunciado via a generalized `OralCalibrationAgent`); (2) **positioning** — a spoken instruction audio (`GET /s/:t/setup-audio?which=position`, TTS in the work voice, cached) + live camera check (MediaPipe pose/hands/phone, `static/vision`) with a **red border + guidance** on any problem, auto-advancing only when OK; (3) **command practice** — a spoken audio (`which=commands`, with a test-only note when `submissions.is_test`) + the 4 corner areas over the self-view + interview-style practice buttons (nothing recorded). `commandZones.js` is a reusable engine: HandLandmarker (2 hands) + a hand-skeleton overlay, corner boxes with strong colors, dwell (1‑2‑3) → `onFire(id)`, per-zone `enabledFn` (state machine: idle → only GRAVAR; recording → ENVIAR/CANCELAR), auto-fit/2-line labels, "inert after fire until the hand leaves". Commanding **INICIAR** ends the setup and (the upload having finished by then) starts the interview.
- **Interview screen**: a self-view (~360 px, above the chat) with the command areas over it — 🟢 GRAVAR (top-right) · 🔴 CANCELAR (top-left) · 🔵 ENVIAR (bottom-right) · 🩵 REPETIR (bottom-left, replays the last interviewer audio). Consent (LGPD) is the **"CIENTE – COMEÇAR"** area (replaces the keyboard checkbox); it stops the instruction audio and releases the interviewer. The areas only **click the existing record/stop-send/stop buttons** — the audio/STT pipeline is unchanged; while an interviewer audio plays, GRAVAR is disabled and CANCELAR stops it. A continuous **video is recorded** and uploaded (`POST /s/:t/proctor-video` → `putAudio` → `submissions.oral_video_key`, reusing the oral columns). On **re-entry to an in-progress interview**, `startProctoring(resume)` re-opens the camera + recording + areas without re-doing setup/consent.
- **Video is MANDATORY and BLOCKING** (migration 072, 2026-08-14 — replaced the earlier fail-open behavior, which silently produced "sem vídeo" submissions). Política única `videoMandatory(work)` em `lib/proctor.js`. Gate em três camadas (`static/js/proctorGate.js`, compartilhado pelos 3 fluxos): (a) **início** — o setup confirma a captura com `probeCapture()` (grava um chunk de teste; pega navegador sem `MediaRecorder`/codec e câmera que abre mas não grava); sem captura, `blockingCameraError()` barra e não libera a entrevista; (b) **meio** — `attachTrackLossGuard()` trava a gravação de respostas se a câmera cair (permissão revogada, webcam desconectada); (c) **fim** — o servidor não conclui sem vídeo: `finalizeWithVideoGate` deixa a submissão em `awaiting_video` (`submissions.awaiting_video`) até o upload chegar (`promoteAwaitingVideo` no `POST /s/:t/proctor-video`, agora com retry no cliente). **Válvula de escape**: o professor libera um aluno com equipamento incompatível via `POST /w/:t/submissions/:sub/waive-video` (`submissions.video_waived`) — botão "Liberar" na coluna Vídeo do painel.
- **No spontaneity contract under fiscalização**: `sess.expectSpontaneous` is gated off when `proctoring_enabled` (both `/start` and `/upload`), so the interviewer drops the "answer from memory / no support material" beat (the camera already enforces integrity); the professor's "resposta de cabeça" checkbox is disabled when the toggle is on.
- **TTS-friendly interviewer speech**: `lib/agentPreamble.js` (audio mode) instructs the interviewer to spell out numbers/units/symbols as spoken ("cerca de mil exa-hashes por segundo", not "~1.000 EH/s"), avoiding `~`, `/`, and abbreviations the TTS mispronounces.
- **Professor side** (`static/conversation.html`): a **"Fiscalização por vídeo"** card runs analysis on demand (`POST /w/:t/submissions/:sub/proctor` → `analyzeOralVideoParts` → `oral_proctor_json`), plays the video (`GET .../proctor-video/:idx`, Range/seek — served by `lib/serveVideo.js` with **true partial reads**; see "Video delivery" below), and shows alert pills. The report **composes the grade** via the shared penalty (`lib/gradePenalty.js#applyPenaltyToGrades` flow `"interview"` now combines authorship + `renderOralAlerts`) and can surface as a soft devolutiva note. Proctoring is deliberately NOT fed into the `InterviewEvaluatorAgent` reasoning (keeps integrity separate from content).
- **Cobertura da análise (2026-08-16, #249 → #270):** o teto que truncava em 20 min sem avisar (#249) virou, por um dia, orçamento adaptativo (1200 quadros com passo esticado pela duração, PR #257). Com a extração streaming e a fila global (PR #266), a motivação de memória/CPU sumiu e a densidade voltou a ser **fixa em 1 s/quadro** (#270): `FRAME_BUDGET = 7200` é só disjuntor de sanidade (2 h), cortando com `truncated: true` — nunca em silêncio. `probeDurationSec` segue medindo a duração real (remux `-c copy`, porque o WebM do MediaRecorder vem sem duração no cabeçalho) para o relatório de cobertura: `video_duration_s`, `covered_s`, `truncated`, `duration_unknown`. Cada flag mantém `count_sec` (laudos da era adaptativa têm passo > 1 s e `count` em QUADROS). `analyzeOralVideoParts` acumula o offset pela duração coberta de cada parte (não por um intervalo único) e publica `part_spans` (parte → janela global), que o painel usa para levar o clique num trecho à parte certa.
- **Player multi-parte (#256):** `static/conversation.html` deixou de ficar cravado em `proctor-video/0`; navega entre as partes, emenda ao fim de cada uma e mostra a fragmentação como alerta. `appendOralVideoPart` passou a guardar em `oral_video_key` a PRIMEIRA parte (antes a última).
- **Schema**: `works.proctoring_enabled` + `works.devolutiva_proctor_prompt` (migration 041); the interview submission **reuses** the oral columns `oral_video_key`/`oral_proctor_json`/`oral_calibration_json`. The command-area scheme was validated with a standalone tuning page, `static/poc/gesture.html` (kept on the `feat/proctor-zone-poc` branch).

## Fila global de análises (issues #261–#264, 2026-08-16; infra #338, 2026-08-27)

A análise de vídeo deixou de rodar solta e passou a ser **serializada por uma fila
global** (`lib/proctorQueue.js`), compartilhada pelos três fluxos (prova oral,
entrevista simplificada, entrevista com fiscalização).

Desde o #338 a fila vive na **tabela `jobs`** (migrations 078/079), como **lane
separada** da retranscrição (`type: video_analysis`) — decisão explícita: as duas
continuam filas logicamente distintas (políticas próprias de prioridade, retry e
concorrência), mas compartilham a mecânica (claim atômico com lease, dedup por
submissão via índice único parcial, repriorização, visibilidade). Com isso a fila
de vídeo **sobrevive a restart** (o claim repesca lease vencida) e ganha trilha
auditável (`attempts`, `last_error`, `result`); a bomba roda no próprio app
(`pump`, acordada também pelo tique do `jobRunner`), e o aborto do admin segue
cooperativo (AbortController em memória — quem roda vídeo é este processo). Tudo
abaixo continua valendo:

- **Disparo**: automático ao fim de cada sessão (`lib/proctorAuto.js` e o pós-upload
  do vídeo oral apenas enfileiram). O lote "Analisar vídeos" do professor **foi
  removido**; o pipeline "Avaliar entrevistas" (routes/work.js) agenda-e-aguarda
  pela mesma fila (respeita a concorrência global, deduplica com o disparo automático).
- **Concorrência**: configurável na tela **Operações** do admin (`app_settings.
  proctor_concurrency`, migration 074; default **1** — protege as provas ao vivo,
  que disputam CPU com a análise). Sem restart.
- **Prioridade e dedup**: pedido manual (Reprocessar do professor/admin) fura fila
  sobre o automático; enfileirar uma submissão já na fila adere ao item existente.
- **Estado persistido** em `oral_voice_json.proctor_status` (`queued`/`running`/
  `failed` + `attempts`); o sucesso limpa o status e grava `attempts` dentro de
  `oral_proctor_json`. **Sem retentativa automática**: falha fica `failed` até um
  humano clicar Reprocessar (professor, ao lado do selo "falhou ⚠"; ou admin).
- **Reconciliação no boot**: submissões com vídeo, sem relatório e sem `failed`
  voltam à fila (órfãs de reinício e legado) — substituiu o antigo "órfã vira
  failed" do #220.
- **Memória**: a extração de frames é **em streaming** (`lib/proctor.js`) — pico
  ≈ 1 frame (1,2 MiB) por análise, qualquer que seja a duração; cobertura integral
  a 1 fps com disjuntor de 2 h (`-frames:v`; `truncated: true` no relatório quando
  dispara). Antes, 40 min de vídeo bufferizavam ~2,8 GiB e derrubavam o processo.
- **Professor**: vê só "em análise" (queued+running), o resultado, ou "falhou ⚠ ·
  Reprocessar". Admin vê a fila, ajusta a concorrência e acompanha falhas
  pendentes/reincidentes na seção Operações; por item (#272): **Priorizar**
  (enfileirado vai à cabeça, prioridade manual), **Cancelar** (retira da fila) e
  **Interromper** (aborto cooperativo do que está rodando — AbortController
  derruba ffmpeg e sidecar). Cancelado/interrompido fica `failed` com motivo
  legível ("cancelada/interrompida pelo admin …") — nunca some em silêncio, e o
  professor recupera com o Reprocessar.

## Video ingest (#357)

The mirror image of delivery: **receiving** a recording must never load it into
memory either. The path from the browser to the object store has two places where
the bytes can pile up, and both had failed.

1. **multer.** The message interview used `memoryStorage` with a 200 MB cap — the
   last of the three flows to do so, and the one with the most volume (145
   submissions against the oral exam's 74, with a 52-minute recording already on
   record). With `memoryStorage`, each upload holds the whole file in RAM for the
   entire transfer, which on mobile is slow; a class finishing together multiplies
   that by the number of students. All three flows now use `dest: os.tmpdir()`.

2. **The read right after multer.** The oral exam and the simplified interview
   already wrote to disk, then undid it on the next line: `readFile(req.file.path)`
   into a Buffer, because `putAudio` only accepted bytes. `putAudioFromFile({ key,
   filePath })` closes this — it hashes with a stream, takes the size from `stat`,
   and hands the path to `uploadFromFilename` (the Replit SDK's; the local backend
   mirrors it with `copyFile`). The bytes never exist all at once in the process.

The professor-side consolidation (`lib/videoConsolidate.js`) followed the same rule:
ffmpeg already writes to disk, so `buildConsolidatedVideoFile` returns the **path**
and the caller uploads by path and deletes it. Ownership is explicit — only the
success path transfers the output file to the caller.

`objectExists` now returns `true | false | **null**`, the last meaning "could not
tell". The distinction matters because the caller does something expensive when the
answer is "no": returning `false` on a storage failure turned instability into a
full re-download plus ffmpeg run. On `null` we serve the raw part instead.

**Over the size cap.** There was no `MulterError` handling and no Express error
handler anywhere in the repo, so an oversized file became a 500 HTML page. The
client read that as "didn't work" and offered the only escape it knew — reload the
page — which is the worst possible advice: the recording lives **only in the
student's tab**, so reloading destroys the very video being sent. `lib/uploadErrors.js`
wraps the multer middleware and answers `413` with JSON pointing at the real way out
(the professor can waive the video). Clients stop retrying on 4xx — the file is the
same size next time — and keep retrying genuine network failures.

`tests/video-upload-disco.test.mjs` asserts the invariants against the route
sources, because this defect survived for months by living in one of the three
files and not the other two.

## Video delivery (#349)

Serving a recording must **never** load the object into memory. A 60-minute
arguição is ~190 MB (640×480 @ 400 kbps), and the previous implementation read the
whole object with `readAllBytes` and sliced the Buffer to answer `Range` — peaking
at roughly twice the file size, per request, on a single 8 GB VM that also hosts the
voice relay. A ~40-minute video already caused a memory incident on 2026-08-16.

`lib/serveVideo.js` streams only the requested span, through
`audioStore.streamRange(key, { start, end })`:

- **local backend**: `fs.createReadStream(path, { start, end })`.
- **replit backend**: `downloadAsStream(key, { start, end })`. The Replit SDK
  forwards `options` straight to the GCS `createReadStream`, which accepts
  `{ start, end }`. This is an **undocumented passthrough** — `tests/video-range.test.mjs`
  asserts it still holds and fails loudly if an SDK bump breaks it. Do not delete
  that test without replacing the guarantee.

`Content-Range` needs the total size, and the SDK's `StorageObject` only exposes
`name`. So the size is written at upload time into `object_sizes` (migration 080),
keyed by object key — which also covers the oral exam's **consolidated** video, whose
key is not in `oral_video_parts`. Objects predating the migration have no recorded
size: those are served whole with `200` (seek degrades, memory stays flat).
