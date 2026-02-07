#!/usr/bin/env bash
set -euo pipefail

# Simple helper to stage, commit and push all changes.
# Usage: ./scripts/auto-commit.sh "Your commit message"

MSG="$1"
if [ -z "$MSG" ]; then
  echo "Usage: $0 \"commit message\""
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "Branch: $BRANCH"

git add -A

# If nothing staged, exit gracefully
if git diff --cached --quiet; then
  echo "No changes to commit."
  exit 0
fi

git commit -m "$MSG"
git push origin "$BRANCH"

echo "Committed and pushed to $BRANCH"
