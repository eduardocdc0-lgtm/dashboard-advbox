#!/bin/bash
set -eo pipefail

GITHUB_REPO_URL="https://github.com/eduardocdc0-lgtm/dashboard-advbox.git"

if [ -z "$GITHUB_PERSONAL_ACCESS_TOKEN" ]; then
  echo "Erro: variável GITHUB_PERSONAL_ACCESS_TOKEN não configurada."
  exit 1
fi

git config user.email "replit-push@advbox.local" 2>/dev/null || true
git config user.name "Replit AdvBox" 2>/dev/null || true

if ! git diff --quiet || ! git diff --staged --quiet; then
  TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
  git add -A
  git commit -m "chore: sync automático do Replit em $TIMESTAMP"
  echo "Alterações locais commitadas."
else
  echo "Nenhuma alteração local pendente."
fi

AUTHENTICATED_URL="https://x-access-token:${GITHUB_PERSONAL_ACCESS_TOKEN}@github.com/eduardocdc0-lgtm/dashboard-advbox.git"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
echo "Fazendo push para o GitHub em $TIMESTAMP..."

git push --force "$AUTHENTICATED_URL" HEAD:main 2>&1 | sed "s/${GITHUB_PERSONAL_ACCESS_TOKEN}/***TOKEN***/g"

echo ""
echo "Push concluído: $GITHUB_REPO_URL"
