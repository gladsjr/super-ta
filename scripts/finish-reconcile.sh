#!/usr/bin/env bash
# Finaliza a reconciliacao: commita os itens ja preparados + envia ao GitHub.
# Rode no Shell:  bash scripts/finish-reconcile.sh
set -uo pipefail

# remove lock obsoleto do origin/HEAD (nao mexe em index.lock ativo)
rm -f .git/refs/remotes/origin/HEAD.lock 2>/dev/null || true

run() {
  local nome="$1"; shift
  for i in 1 2 3 4 5; do
    if "$@"; then return 0; fi
    if [ "$i" -ge 3 ] && [ -f .git/index.lock ]; then
      echo "   (index.lock parece obsoleto; removendo e tentando de novo...)"
      rm -f .git/index.lock 2>/dev/null || true
    else
      echo "   ($nome ocupado; tentativa $i/5, aguardando 4s...)"
      sleep 4
    fi
  done
  return 1
}

git add .agents/ reports/ .replit
if git diff --cached --quiet; then
  echo "Nada novo para commitar (um checkpoint automatico ja salvou as mudancas)."
else
  run "commit" git commit -m "chore: reconciliar com origin/main (prova oral) + preservar memoria/relatorios + deploy VM" || { echo "FALHOU no commit"; exit 1; }
fi

echo "Enviando para o GitHub (sem force)..."
run "push" git push origin main || { echo "FALHOU no push"; exit 1; }

echo
echo "================  RESULTADO  ================"
git status -sb | head -1
git log --oneline -3
echo "PRONTO. Me avise aqui no chat que eu confiro tudo."
