#!/bin/sh
# Publishes docs/requirements/*.md as GitHub issues (idempotent: skips titles that
# already exist). Requires an authenticated gh with repo scope.
set -eu
repo="${1:-all-the-rest/agent-tasks}"
for file in docs/requirements/*.md; do
  title="$(sed -n '1s/^# //p' "$file")"
  labels="$(sed -n '3s/^_Labels: //; 3s/_$//p' "$file" | tr -d ' ')"
  if [ -z "$title" ]; then echo "skip $file (no title)"; continue; fi
  if gh issue list --repo "$repo" --state all --search "$title in:title" --json title --jq '.[].title' | grep -Fxq "$title"; then
    echo "exists: $title"
    continue
  fi
  set -- --repo "$repo" --title "$title" --body-file "$file"
  if [ -n "$labels" ] && [ "$labels" != "none" ]; then
    for label in $(echo "$labels" | tr ',' ' '); do
      set -- "$@" --label "$label"
    done
  fi
  gh issue create "$@" >/dev/null && echo "created: $title"
done
