#!/bin/bash
set -e

GITHUB_REPO="https://github.com/eduardocdc0-lgtm/dashboard-advbox.git"

if [ -z "$GITHUB_PERSONAL_ACCESS_TOKEN" ]; then
  echo "Erro: variável GITHUB_PERSONAL_ACCESS_TOKEN não configurada."
  exit 1
fi

AUTHENTICATED_URL="https://${GITHUB_PERSONAL_ACCESS_TOKEN}@github.com/eduardocdc0-lgtm/dashboard-advbox.git"

git config user.email "replit-push@advbox.local" 2>/dev/null || true
git config user.name "Replit AdvBox" 2>/dev/null || true

if git remote get-url github 2>/dev/null; then
  git remote set-url github "$AUTHENTICATED_URL"
else
  git remote add github "$AUTHENTICATED_URL"
fi

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
echo "Fazendo push para o GitHub em $TIMESTAMP..."
git push github main 2>&1 | sed "s/${GITHUB_PERSONAL_ACCESS_TOKEN}/***TOKEN***/g"

git remote set-url github "$GITHUB_REPO"

echo "Push concluído com sucesso!"
