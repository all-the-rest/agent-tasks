#!/bin/sh
# Start, stop or inspect one named deployment stack.
#
#   deployment/stack.sh production --profile search up -d
#   deployment/stack.sh local --profile mail --profile search up -d --build
#   deployment/stack.sh e2e --profile mail --profile search up -d --build
#   deployment/stack.sh local ps
#   deployment/stack.sh e2e down -v
#
# The stack is selected by its compose file (name: agent-tasks[-local|-e2e]);
# every service also carries the label com.agent-tasks.stack=<stack>.
set -eu

usage() {
  cat <<'EOF'
Usage: deployment/stack.sh <production|local|e2e> <docker compose arguments...>

The environment file deployment/env/<stack>.env is created from the example on
first use. For local and e2e every __GENERATE__ marker is replaced with a random
value. production.env is never generated silently: copy the example and replace
the replace-with-* values (config validation is allowed before that).
EOF
}

stack=${1:-}
[ -n "$stack" ] || { usage >&2; exit 2; }
shift

case "$stack" in
  production|local|e2e) ;;
  *) usage >&2; exit 2 ;;
esac

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
env_file="$dir/env/$stack.env"
example="$dir/env/$stack.env.example"

if [ ! -f "$env_file" ]; then
  case " $* " in
    *" config "*)
      cp "$example" "$env_file"
      echo "stack: created $env_file from the example for validation" >&2
      ;;
    *)
      if [ "$stack" = production ]; then
        echo "stack: $env_file is missing" >&2
        echo "       cp $example $env_file, then replace every replace-with-* value" >&2
        exit 1
      fi
      cp "$example" "$env_file"
      ;;
  esac
fi

# Fill generated values once. The temporary file keeps base64 padding and
# slashes out of sed's delimiter handling.
fill() {
  key=$1
  value=$2
  tmp="$env_file.tmp"
  sed "s|^${key}=__GENERATE__$|${key}=${value}|" "$env_file" > "$tmp"
  mv "$tmp" "$env_file"
}

if [ "$stack" != production ] && grep -q '=__GENERATE__$' "$env_file"; then
  umask 077
  fill POSTGRES_PASSWORD "$(openssl rand -hex 24)"
  fill AUTH_SECRET "$(openssl rand -hex 32)"
  fill SECRETS_ENCRYPTION_KEY "$(openssl rand -base64 32)"
  fill RUNNER_TOKEN "$(openssl rand -hex 24)"

  setup_token="setup-$(openssl rand -hex 16)"
  fill SETUP_TOKEN "$setup_token"
  fill E2E_SETUP_TOKEN "$setup_token"

  admin_password="Admin-$(openssl rand -hex 12)"
  fill ADMIN_PASSWORD "$admin_password"
  fill E2E_ADMIN_PASSWORD "$admin_password"

  if grep -q '=__GENERATE__$' "$env_file"; then
    echo "stack: $env_file still contains __GENERATE__ markers" >&2
    exit 1
  fi
  chmod 600 "$env_file"
  echo "stack: generated secrets in $env_file" >&2
fi

if grep -qE '^[A-Za-z_][A-Za-z0-9_]*=replace-with' "$env_file"; then
  case " $* " in
    *" config "*) ;;
    *)
      echo "stack: $env_file still has replace-with-* placeholders" >&2
      echo "       fill them before starting the production stack" >&2
      exit 1
      ;;
  esac
fi

exec docker compose --env-file "$env_file" -f "$dir/compose.$stack.yaml" "$@"
