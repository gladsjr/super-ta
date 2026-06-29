---
name: Git destrutivo exige task agent isolado
description: No Replit o agente principal é bloqueado de git destrutivo; reset/commit/checkout/rebase/force-push só rodam em task agent isolado.
---

# Git destrutivo é bloqueado para o agente principal

Tentar `git reset`, `git commit`, `git checkout`, `git restore`, `git clean`, `git rebase` ou **force-push** pelo agente principal — **mesmo em Build mode executando uma Project Task atribuída a ele** — retorna:

> "Destructive git operations are not allowed in the main agent. Propose a background Project Task to perform this git operation instead."

**Permitido ao agente principal:** git read-only (use `--no-optional-locks`), `git fetch`, criar branch (`git branch -f <novo> <ref>`). Push **sem** force não está na lista de bloqueados (force está), mas não foi confirmado neste caso.

**Why:** A plataforma reserva git destrutivo para **task agents isolados** (ambiente próprio + proteções + merge-back automático), evitando que o agente principal reescreva/corrompa o histórico do repl ao vivo. Confirmado em jun/2026 ao tentar reconciliar `main` divergente: o reset foi recusado mesmo com a operação já formalizada como Project Task e atribuída ao agente principal.

**How to apply:** Para reconciliar branches, rebase, reset, checkout ou qualquer history-rewrite: NÃO atribua a tarefa ao agente principal. Crie a Project Task e oriente o usuário a executá-la com um **agente de tarefa isolado**. O agente isolado roda o git destrutivo (e pode dar push no remoto) no próprio ambiente; a plataforma faz o merge-back para o `main`.
