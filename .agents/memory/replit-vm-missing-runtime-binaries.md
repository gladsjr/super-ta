---
name: Dev tem binários do replit-runtime-path que a VM publicada não tem
description: '"Funciona no teste, ENOENT no prod": binários como ffmpeg vêm do runtime do Replit no dev, mas a VM só recebe o que está no replit.nix.'
---

No shell/dev deste repl, alguns binários (ex.: `ffmpeg`/`ffmpeg-full`) vêm de
`/nix/store/...replit-runtime-path/bin` — parte do ambiente de DESENVOLVIMENTO
do Replit, **não** declarada no `replit.nix`. A VM publicada (deployment) só
recebe o que está no `replit.nix` (mais `node_modules`/`.pythonlibs` via snapshot
do workspace). Resultado clássico: funciona no teste, mas em produção o servidor
lança `spawn <bin> ENOENT`.

**Why:** dev e prod divergem — o dev tem um toolchain mais rico que a VM. Já
mordeu com `ffmpeg` no proctoring (extractFrames de vídeo) logo depois do
`libxcb` (necessário ao mediapipe).

**How to apply:** antes de confiar num binário que o servidor faz `spawn` em
produção, rode `ls -la $(which <bin>)` no dev; se apontar para
`replit-runtime-path` e não estiver no `replit.nix`, adicione via
`installSystemDependencies` (do skill package-management) e **republique** — só
assim a VM recebe. Edições diretas a `.replit`/`replit.nix` são BLOQUEADAS; use
sempre as ferramentas (package-management / workflows), nunca `edit`.
