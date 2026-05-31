---
name: Servidor stale após troca de branch/pull
description: Erros fantasma (rota 404, ENOENT de arquivo de config) quando o workflow Node não é reiniciado após mudança de arquivos no disco
---

# Servidor Node fica "stale" após trocar de branch / baixar versão do GitHub

Sintoma: o app publicado/preview dá um erro que **não corresponde ao código no disco**.
Exemplos já vistos:
- `Cannot PATCH /w/.../name` (404) — a rota existe no disco mas o processo em memória é anterior ao commit que a adicionou.
- `ENOENT ... config/system_prompt.txt` — o commit no disco já removeu esse arquivo e toda referência a ele, mas o processo em memória ainda é o código antigo que tentava abri-lo.

**Causa:** o processo `node server.js` (workflow "Start application") não recarrega arquivos sozinho. Trocar de branch ou dar pull muda os arquivos no disco, mas o processo continua executando o código que estava em memória quando foi iniciado.

**Como aplicar / diagnóstico rápido:**
1. Reproduza o endpoint que falha (ex.: `curl -i -X PATCH localhost:5000/...`).
2. Compare com o disco: `rg` pela string/rota/arquivo do erro. Se o disco **não** bate com o erro (rota existe mas dá 404; arquivo já foi removido mas dá ENOENT), é servidor stale.
3. Confirmação extra: `ps -ef | grep server.js` e compare o horário de início do processo com o mtime do arquivo (`stat -c %y`). Processo mais velho que o arquivo ⇒ stale.
4. Fix: `restart_workflow("Start application")` e re-teste o endpoint.

**Regra para o usuário (não-técnico):** toda vez que trocar de branch ou baixar versão nova do GitHub, reiniciar o workflow antes de testar.
