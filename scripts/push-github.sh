#!/bin/bash
set -e

GITHUB_REPO="https://github.com/eduardocdc0-lgtm/dashboard-advbox.git"
REMOTE_NAME="github"

if [ -z "$GITHUB_PERSONAL_ACCESS_TOKEN" ]; then
  echo "Erro: variável GITHUB_PERSONAL_ACCESS_TOKEN não configurada."
  exit 1
fi

git config user.email "replit-push@advbox.local" 2>/dev/null || true
git config user.name "Replit AdvBox" 2>/dev/null || true

cleanup() {
  if git remote get-url "$REMOTE_NAME" 2>/dev/null | grep -q "x-access-token"; then
    git remote set-url "$REMOTE_NAME" "$GITHUB_REPO"
  fi
}
trap cleanup EXIT

AUTHENTICATED_URL="https://x-access-token:${GITHUB_PERSONAL_ACCESS_TOKEN}@github.com/eduardocdc0-lgtm/dashboard-advbox.git"

if git remote get-url "$REMOTE_NAME" 2>/dev/null; then
  git remote set-url "$REMOTE_NAME" "$AUTHENTICATED_URL"
else
  git remote add "$REMOTE_NAME" "$AUTHENTICATED_URL"
fi

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
echo "Fazendo push para o GitHub em $TIMESTAMP..."
git push "$REMOTE_NAME" main 2>&1 | sed "s/${GITHUB_PERSONAL_ACCESS_TOKEN}/***TOKEN***/g"

echo "Push concluído com sucesso!"
