#!/usr/bin/env bash
# Push the production compose file to the Docker host and reconcile the stack.
#
# The host keeps the state in /opt/stacks/agent-tasks:
#   compose.yaml  written by this script from deployment/compose.production.yaml
#   .env          created once by hand, root:root 0600, never overwritten
#
# Usage:
#   deployment/deploy.sh [--dry-run]
#
# Environment overrides:
#   DEPLOY_HOST          default root@reisinger.pictures
#   DEPLOY_WAIT_TIMEOUT  seconds for `docker compose up --wait` (default 180)
set -euo pipefail

host="${DEPLOY_HOST:-root@reisinger.pictures}"
stack="agent-tasks"
remote_dir="/opt/stacks/${stack}"
wait_timeout="${DEPLOY_WAIT_TIMEOUT:-180}"
local_file="$(cd -- "$(dirname -- "$0")" && pwd)/compose.production.yaml"
ssh_opts=(-o ControlMaster=auto -o "ControlPath=/tmp/ssh-deploy-%r@%h:%p" -o ControlPersist=60)

usage() {
  printf 'usage: %s [--dry-run]\n' "$0" >&2
}

dry_run=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -n | --dry-run)
      dry_run=1
      ;;
    -h | --help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *)
      echo "deploy: unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
  shift
done

# The value ends up in a remote shell command; only a plain integer may pass.
case "$wait_timeout" in
  '' | *[!0-9]*)
    echo "deploy: DEPLOY_WAIT_TIMEOUT must be a positive integer, got: $wait_timeout" >&2
    exit 2
    ;;
esac
if [ "$wait_timeout" -le 0 ]; then
  echo "deploy: DEPLOY_WAIT_TIMEOUT must be greater than zero, got: $wait_timeout" >&2
  exit 2
fi

run() {
  if [ "$dry_run" -eq 1 ]; then
    printf 'dry-run: %s\n' "$*"
  else
    "$@"
  fi
}

# Remote secrets stay on the host. Refuse early instead of deploying without them.
# The dry run stays offline: it prints the preflight instead of connecting.
if [ "$dry_run" -eq 1 ]; then
  printf 'dry-run: ssh %s %s %s\n' "${ssh_opts[*]}" "$host" "test -f '${remote_dir}/.env'"
elif ! ssh "${ssh_opts[@]}" "$host" "test -f '${remote_dir}/.env'"; then
  echo "deploy: ${remote_dir}/.env is missing on ${host}" >&2
  echo "        Create it once from deployment/env/production.env.example (chmod 600)" >&2
  echo "        and set RUNNER_SECCOMP_PATH=/opt/agent-tasks/seccomp-browser.json" >&2
  echo "        (plus SEARXNG_SETTINGS_PATH for the search profile)." >&2
  exit 1
fi

run rsync -q -e "ssh ${ssh_opts[*]}" "$local_file" "${host}:${remote_dir}/compose.yaml"
run ssh "${ssh_opts[@]}" "$host" \
  "chmod 0644 '${remote_dir}/compose.yaml' && cd '${remote_dir}' && docker compose up -d --wait --wait-timeout ${wait_timeout}"

if [ "$dry_run" -eq 0 ]; then
  ssh "${ssh_opts[@]}" "$host" "cd '${remote_dir}' && docker compose ps"
fi
