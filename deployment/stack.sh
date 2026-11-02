#!/bin/sh
# Start, stop or inspect one local deployment stack.
#
#   deployment/stack.sh local --profile mail --profile search up -d --build
#   deployment/stack.sh e2e --profile mail --profile search up -d --build
#   deployment/stack.sh local ps
#   deployment/stack.sh e2e down -v
#   deployment/stack.sh production config -q   # local validation only
#
# Production itself runs on the Docker host and is deployed by deployment/deploy.sh.
#
# The stack is selected by its compose file (name: agent-tasks[-local|-e2e]);
# every service also carries the label com.agent-tasks.stack=<stack>.
set -eu

usage() {
  cat <<'EOF'
Usage: deployment/stack.sh <local|e2e> <docker compose arguments...>
       deployment/stack.sh production config [docker compose config arguments...]

The environment file deployment/env/<stack>.env is created from the example on
first use. For local and e2e every __GENERATE__ marker is replaced with a random
value.

Production is deployed on the Docker host from /opt/stacks/agent-tasks by
deployment/deploy.sh. `stack.sh production` only renders the vendored production
compose file with deployment/env/production.env.example for local config
validation; it never starts, stops or pulls the production stack and never creates
a local production.env.
EOF
}

stack=${1:-}
[ -n "$stack" ] || { usage >&2; exit 2; }
shift

case "$stack" in
  production|local|e2e) ;;
  *) usage >&2; exit 2 ;;
esac

dir=$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd)
example="$dir/env/$stack.env.example"

# Production is host-managed. Do not let this helper create or start a local
# production stack: only config rendering is supported, and it uses the committed
# example so no local production.env can drift from the host .env.
if [ "$stack" = production ]; then
  # Only the `config` subcommand is allowed. Checking the first argument (not a
  # substring of all arguments) keeps `production up config` and similar
  # combinations from starting or mutating anything.
  if [ "$#" -eq 0 ] || [ "$1" != "config" ]; then
    echo "stack: production is managed on the Docker host in /opt/stacks/agent-tasks" >&2
    echo "       Deploy from a checkout with DEPLOY_HOST=user@host deployment/deploy.sh" >&2
    echo "       stack.sh production is limited to local 'config' validation" >&2
    exit 1
  fi
  exec docker compose -p agent-tasks --env-file "$example" \
    --project-directory "$dir/.." -f "$dir/compose.production.yaml" "$@"
fi

env_file="$dir/env/$stack.env"

if [ ! -f "$env_file" ]; then
  cp "$example" "$env_file"
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

if grep -q '=__GENERATE__$' "$env_file"; then
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
  echo "stack: $env_file still has replace-with-* placeholders" >&2
  echo "       fill them before starting the stack" >&2
  exit 1
fi

# The local and E2E files use `include`, which resolves its path against the
# project directory, so they keep the default one.
exec docker compose --env-file "$env_file" -f "$dir/compose.$stack.yaml" "$@"
