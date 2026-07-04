#!/bin/bash
set -euo pipefail

echo "[post-merge] npm install"
npm install --no-audit --no-fund --no-progress

# Gêmeo Python do npm install: reinstala as deps do sidecar de proctoring
# (mediapipe/opencv). .pythonlibs/ é gitignored e chega à VM só pelo snapshot;
# num ambiente do zero (fork/reset/migração) nada o reconstrói sem isto.
# PYTHONUSERBASE fixado aqui para não depender do ambiente já tê-lo setado
# (senão --user cairia em ~/.local e o app não acharia os pacotes). Falha real
# de pip aborta (fail-fast, igual ao npm install); só a AUSÊNCIA de python é
# tolerada.
echo "[post-merge] deps Python do proctoring (requirements.txt)"
export PYTHONUSERBASE="${PYTHONUSERBASE:-$PWD/.pythonlibs}"
if command -v python >/dev/null 2>&1; then
  python -m pip install --user --no-input -r requirements.txt
else
  echo "[post-merge] python ausente — proctoring de mãos/enquadramento indisponível"
fi

if [ -n "${DATABASE_URL:-}" ]; then
  echo "[post-merge] applying migrations (npm run db:migrate)"
  npm run db:migrate
else
  echo "[post-merge] DATABASE_URL not set, skipping migrations"
fi

echo "[post-merge] done"
