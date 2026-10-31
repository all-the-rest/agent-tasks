#!/bin/sh
# The counts behind ratchet.config.jsonc. One function per defect class; the
# scope is the shipped source (apps, services, packages) without tests, dist or
# node_modules, so a test fixture never inflates a gate.
set -eu
rule="${1:-}"
root="$(cd "$(dirname "$0")/.." && pwd)"

scopes() {
  find "$root/apps" "$root/services" "$root/packages" \
    \( -name node_modules -o -name dist -o -path '*/test/*' -o -name '*.test.ts' \) -prune -o \
    \( -name '*.ts' -o -name '*.tsx' \) -print
}

case "$rule" in
  no-unfinished-marker)
    scopes | xargs grep -nE '\b(TODO|FIXME|XXX)\b' 2>/dev/null | wc -l | tr -d '[:space:]'
    ;;
  no-explicit-any)
    scopes | xargs grep -nE ':\s*any\b|<any>' 2>/dev/null | wc -l | tr -d '[:space:]'
    ;;
  no-raw-html)
    scopes | xargs grep -n 'dangerouslySetInnerHTML' 2>/dev/null | wc -l | tr -d '[:space:]'
    ;;
  no-baked-secret)
    scopes | xargs grep -nE 'sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY' 2>/dev/null | wc -l | tr -d '[:space:]'
    ;;
  dependency-count)
    cat "$root"/package.json "$root"/apps/*/package.json "$root"/services/*/package.json "$root"/packages/*/package.json \
      | grep -cE '"(dependencies|devDependencies)"' | tr -d '[:space:]'
    ;;
  *)
    echo "unknown rule: $rule" >&2
    exit 2
    ;;
esac
