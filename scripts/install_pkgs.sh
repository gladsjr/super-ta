#!/bin/bash
# Instala dependências no início de sessões do Claude Code on the web (cloud).
# A VM da nuvem sobe com um clone limpo do repo, SEM node_modules — sem isto,
# qualquer `node`/`npm run` falha com módulos ausentes. Localmente é no-op:
# use seu fluxo normal (npm install / predev). Requer acesso de rede ao
# registry npm (incluído na allowlist "Trusted" padrão).
#
# Idempotente: pula se node_modules já existe (ex.: ao retomar uma sessão).

if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

if [ -d node_modules ]; then
  exit 0
fi

echo "[install_pkgs] cloud session — rodando npm install..."
npm install --no-audit --no-fund || echo "[install_pkgs] npm install falhou (siga mesmo assim)"
exit 0
