---
name: Processos longos no Replit precisam ser workflow
description: Por que tarefas >120s não sobrevivem em bash background e como rodá-las
---

Processos disparados dentro de uma chamada do bash tool (mesmo com `nohup`/`setsid`/`&`) são REAPED quando a chamada termina. Só processos gerenciados por WORKFLOW sobrevivem entre tool calls.

**Why:** o bash tool tem timeout máximo de 120s e encerra o grupo de processos ao retornar; por isso um `node server.js` registrado em workflow persiste (PID estável), mas um `nohup node run.mjs &` some assim que o bash retorna.

**How to apply:** para qualquer tarefa longa (harness E2E de ~5–20min, scripts de migração demorados, etc.), registre um workflow dedicado (`configureWorkflow`, `outputType` console, sem `waitForPort` se não expõe porta), faça polling dos arquivos de saída/PID entre chamadas e remova o workflow (`removeWorkflow`) ao terminar.
