---
name: Rodar o harness de áudio E2E no Replit
description: Pré-requisitos (Chromium, credenciais) e modo remoto para tests/audio-e2e
---

O harness `tests/audio-e2e/run.mjs` precisa de Chromium e de uma sessão de aluno.

- **Navegador:** não há Google Chrome no NixOS/Replit. Instale `pkgs.chromium` (replit.nix) e rode com `PLAYWRIGHT_CHROME_PATH=<...>/bin/chromium` (o ramo opt-in usa `executablePath` + `--no-sandbox`). Sem a env, o harness tenta `channel:"chrome"`, que não existe aqui.
- **Login:** `seed.mjs` tem credenciais padrão (`gladstone`/`senha123`) que NÃO existem no DB de dev (usuários vêm do secret `INITIAL_USERS`; em dev só há `admin`, senha desconhecida — não ler o secret).
- **Solução:** use o MODO REMOTO (`seedRemote`) contra um trabalho de áudio já configurado: cria a submissão sem login e puxa `voice`/`questions` da config do trabalho (flags `--voice`/`--questions` são ignoradas). Comando: `node tests/audio-e2e/run.mjs --base http://127.0.0.1:5000 --work <token> --persona <p>`. Use `127.0.0.1`, nunca `localhost`.
- **Custo/efeito:** cada run cria uma submissão de teste no trabalho e gasta tokens reais (STT + reasoning gpt-5.5 + TTS). Cada turno leva ~3–4min; persona "enrolando" provoca follow-ups (force-finalize em `questions × 3`).
- **Veredito:** `report.json` (`ok`, `finishedPhase` ∈ finalizing/finalized, `pageErrors`/`consoleErrors`), `transcript.md`, `audio/*.mp3`. `consoleError` 410 (Gone) é benigno.
