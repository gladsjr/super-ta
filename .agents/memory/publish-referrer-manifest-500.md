---
name: Publish falha no "referrer manifest" com HTTP 500
description: Assinatura de falha transitória do registry do Replit no fim do build; retry resolve
---

Sintoma: o build de publish passa por tudo (security scan, npm/pip install, camadas, "Pushed image manifest", "Pushed soci index manifest") e morre no ÚLTIMO passo:

`fatal: failed to push referrer manifest: PUT https://deployer.replit.com/registry/... : HTTP 500` (às vezes precedido de retries automáticos com "registry returned retryable HTTP status 500").

**Why:** ocorreu 2× (25/07/2026 e 27/07/2026), em publishes com conteúdos completamente diferentes; nas duas vezes nada de errado no projeto, e em 25/07 o retry ~6 min depois passou limpo. É infra do Replit (registry), não build/promote do app.

**How to apply:** não caçar causa no código nem mexer em config — verificar o tail do build log; se a assinatura for essa, recomendar republicar. A versão no ar não é afetada (deploy anterior continua servindo). Se falhar repetidamente em sequência com o mesmo 500, aí sim contatar o suporte do Replit.
