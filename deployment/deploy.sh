#!/usr/bin/env bash
# Push the production compose file and host support assets to the Docker host and
# reconcile the stack.
#
# The host keeps the state in /opt/stacks/agent-tasks:
#   compose.yaml                  written by this script from deployment/compose.production.yaml
#   docker/seccomp-browser.json   written by this script from docker/seccomp-browser.json
#   .env                          created once by hand, root:root 0600, never overwritten
#   docker/searxng/settings.yml   optional, created once by hand for the search profile
#   backups/<timestamp>/          root-only .env and database backups
#
# New files are staged as *.next and only promoted after the preflight succeeds.
#
# Usage:
#   DEPLOY_HOST=root@docker.example deployment/deploy.sh [--dry-run]
#
# Environment:
#   DEPLOY_HOST               required SSH target (for example root@docker.example)
#   DEPLOY_WAIT_TIMEOUT       seconds for `docker compose up --wait` (default 180)
#   DEPLOY_DB_BACKUP_CONFIRM  set to `backed-up` only when an existing Postgres
#                             volume cannot be dumped because the database is
#                             stopped and you have already taken the documented
#                             pg_dump backup
set -euo pipefail

stack="agent-tasks"
remote_dir="/opt/stacks/${stack}"
# Every remote Compose invocation pins these explicitly. The host .env must not
# select a different file or project through COMPOSE_FILE/COMPOSE_PROJECT_NAME.
compose_project="agent-tasks"
remote_compose="${remote_dir}/compose.yaml"
remote_seccomp="${remote_dir}/docker/seccomp-browser.json"
wait_timeout="${DEPLOY_WAIT_TIMEOUT:-180}"
host="${DEPLOY_HOST:-}"
backup_confirm="${DEPLOY_DB_BACKUP_CONFIRM:-}"
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
local_compose="${script_dir}/compose.production.yaml"
local_seccomp="${script_dir}/../docker/seccomp-browser.json"
ssh_control_dir="${HOME:?HOME is required for the private SSH control directory}/.ssh/agent-tasks-deploy"
ssh_known_hosts="${HOME}/.ssh/known_hosts"
ssh_opts=(
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=${ssh_known_hosts}"
  -o ControlMaster=auto
  -o "ControlPath=${ssh_control_dir}/%r@%h:%p"
  -o ControlPersist=60
)

usage() {
  cat <<'EOF'
usage: DEPLOY_HOST=user@host deployment/deploy.sh [--dry-run]

Push deployment/compose.production.yaml and docker/seccomp-browser.json to
/opt/stacks/agent-tasks on the Docker host, back up the host .env and database,
then reconcile the agent-tasks Compose project.

The host .env, SearXNG settings and backups stay on the host and are never
printed or overwritten. The external Docker network `webnet` must already exist
(Caddy/proxy-owned) with exactly subnet 172.18.0.0/16 and gateway 172.18.0.1.
The API uses the fixed address 172.18.0.70 and is reachable by the proxy.

Options:
  -n, --dry-run  print the preflight and commands; do not contact the host
  -h, --help     show this help

Environment:
  DEPLOY_HOST               required SSH target (for example root@docker.example)
  DEPLOY_WAIT_TIMEOUT       seconds for `docker compose up --wait` (default 180)
  DEPLOY_DB_BACKUP_CONFIRM  `backed-up` only after a manual dump when Postgres is
                            stopped (for example during the Portainer migration)

The SSH connection uses BatchMode, a connect timeout and strict host-key
checking against the operator's existing ~/.ssh/known_hosts. Without that file
the deploy stops before contacting the host; add the key with an ordinary
interactive ssh first.

Before the active stack is changed, the remote preflight checks:
  - /opt/stacks/agent-tasks/.env is a root:root 0600 regular file, does not set
    COMPOSE_FILE or COMPOSE_PROJECT_NAME, and no compose.override.* file exists
  - the locally staged seccomp profile is valid JSON before it is transferred
  - the *effective* values rendered by `docker compose config` (not the raw
    .env text) are set, contain no placeholders, and use an HTTPS
    PUBLIC_BASE_URL with a host name
  - RUNNER_TOKEN is set on worker and browser-runner with the same value and is
    absent from api (the token never belongs to the API service)
  - OPENCODE_PROVISIONER_TOKEN is set on the worker: the worker has no fallback
    execution path, so a deploy without it would only create a restart loop
  - the rendered project name is exactly agent-tasks
  - webnet exists with exactly subnet 172.18.0.0/16 and gateway 172.18.0.1
  - the host-only SearXNG settings exist and are not a placeholder when the
    search profile is active

Every remote Compose command is pinned to `-p agent-tasks
--env-file /opt/stacks/agent-tasks/.env -f /opt/stacks/agent-tasks/compose.yaml`
(compose.yaml.next while validating the candidate).

The deploy then writes a root-only backup of .env and (when Postgres already
runs) a pg_dump under /opt/stacks/agent-tasks/backups/<UTC timestamp>/ before
promoting the staged compose file and running `docker compose up`. It never
creates webnet or a host .env. When the staged seccomp profile changed, only
browser-runner is force-recreated; other services and profiles are untouched.
EOF
}

dry_run=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -n | --dry-run)
      dry_run=1
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "deploy: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [ -z "$host" ]; then
  echo "deploy: DEPLOY_HOST is required (for example DEPLOY_HOST=root@docker.example)" >&2
  exit 2
fi
# A leading dash would be parsed by ssh as an option, not as the destination.
case "$host" in
  -*)
    echo "deploy: DEPLOY_HOST must not start with '-'" >&2
    exit 2
    ;;
esac
if ! [[ "$host" =~ ^[A-Za-z0-9._@:-]+$ ]]; then
  echo "deploy: DEPLOY_HOST contains unsupported characters: $host" >&2
  exit 2
fi

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

case "$backup_confirm" in
  '' | backed-up) ;;
  *)
    echo "deploy: DEPLOY_DB_BACKUP_CONFIRM must be 'backed-up' or unset" >&2
    exit 2
    ;;
esac

for file in "$local_compose" "$local_seccomp"; do
  if [ ! -f "$file" ]; then
    echo "deploy: required local file is missing: $file" >&2
    exit 1
  fi
done

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    return 1
  fi
}

local_seccomp_hash=$(hash_file "$local_seccomp") || {
  echo "deploy: sha256sum or shasum is required to detect staged seccomp changes" >&2
  exit 1
}

# The Docker daemon parses this file before the container starts, and the host
# must never receive a truncated or hand-edited profile. Validate it locally and
# fail closed before any transfer or promotion.
validate_seccomp_json() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        document = json.load(handle)
except Exception:
    sys.exit(1)
sys.exit(0 if isinstance(document, dict) else 1)' "$1"
  elif command -v node >/dev/null 2>&1; then
    node -e 'const fs = require("node:fs");
const document = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (document === null || typeof document !== "object" || Array.isArray(document)) {
  process.exit(1);
}' "$1"
  else
    echo "deploy: python3 or node is required to validate $1" >&2
    return 1
  fi
}
if ! validate_seccomp_json "$local_seccomp"; then
  echo "deploy: ${local_seccomp} is not a valid JSON object; refusing to stage it" >&2
  exit 1
fi

# A shared control socket and strict host-key checking need a private local
# state. Dry runs stay offline and must not create or require either.
if [ "$dry_run" -eq 0 ]; then
  if [ ! -f "$ssh_known_hosts" ] || [ ! -r "$ssh_known_hosts" ]; then
    echo "deploy: ${ssh_known_hosts} is missing or unreadable" >&2
    echo "        Connect once with an ordinary ssh command and verify the host key," >&2
    echo "        or copy the host key into ${ssh_known_hosts}; strict checking is enforced." >&2
    exit 1
  fi
  if [ -L "$ssh_control_dir" ] || { [ -e "$ssh_control_dir" ] && [ ! -d "$ssh_control_dir" ]; }; then
    echo "deploy: ${ssh_control_dir} must be a directory, not a symlink or file" >&2
    exit 1
  fi
  umask 077
  mkdir -p -- "$ssh_control_dir"
  chmod 700 "$ssh_control_dir"
fi

# Source-controlled release interlock. The isolated OpenCode runtime is the
# worker's only execution path, and its production verification gates are still
# open. Deploying would push a worker that exits at startup and restart-loops,
# because the same preflight refuses the runtime profile. A file (not an
# environment value) is used deliberately: no host .env or token can bypass it.
# Remove it in the same reviewed change that closes the gates in
# docs/architecture/opencode-runtime-isolation.md.
if [ ! -f "${script_dir}/OPENCODE_RUNTIME_APPROVED" ]; then
  if [ "$dry_run" -eq 1 ]; then
    printf 'dry-run: production execution is blocked until the OpenCode runtime gates pass (%s is absent)\n' "${script_dir}/OPENCODE_RUNTIME_APPROVED" >&2
  else
    echo "deploy: production execution is blocked: the isolated OpenCode runtime is required and its verification gates are still open." >&2
    echo "        A deploy now would leave the worker in a restart loop. See docs/architecture/opencode-runtime-isolation.md." >&2
    exit 1
  fi
fi

run() {
  if [ "$dry_run" -eq 1 ]; then
    printf 'dry-run: %s\n' "$*"
  else
    "$@"
  fi
}

print_remote_script() {
  label=$1
  script=$2
  printf 'dry-run: [%s] ssh %s %s %s\n' \
    "$label" "${ssh_opts[*]}" "$host" \
    "REMOTE_DIR='${remote_dir}' DB_BACKUP_CONFIRM='${backup_confirm}' sh -s"
  printf '%s\n' "$script" | sed 's/^/dry-run:   /'
}

run_remote_script() {
  label=$1
  script=$2
  if [ "$dry_run" -eq 1 ]; then
    print_remote_script "$label" "$script"
  else
    # shellcheck disable=SC2029 # remote_dir is a fixed local constant, not input
    printf '%s\n' "$script" | ssh "${ssh_opts[@]}" "$host" \
      "REMOTE_DIR='${remote_dir}' DB_BACKUP_CONFIRM='${backup_confirm}' sh -s"
  fi
}

remote_prereq() {
  cat <<'REMOTE'
set -eu

fail() {
  printf 'deploy prereq: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "the Docker CLI is not available on the host"
command -v python3 >/dev/null 2>&1 ||
  fail "python3 is required on the host to validate the effective Compose configuration without printing secrets"

[ -d "$REMOTE_DIR" ] || fail "$REMOTE_DIR is missing; create it and the host .env first"
[ ! -L "$REMOTE_DIR" ] || fail "$REMOTE_DIR must not be a symlink"
cd "$REMOTE_DIR"

[ -f .env ] || fail "$REMOTE_DIR/.env is missing; create it from deployment/env/production.env.example as root:root 0600"
[ ! -L .env ] || fail "$REMOTE_DIR/.env must be a regular file, not a symlink"
owner_mode=$(stat -c '%U:%G %a' .env)
[ "$owner_mode" = "root:root 600" ] ||
  fail "$REMOTE_DIR/.env must be root:root 0600 (found $owner_mode)"

# An implicit Compose override or a project/file selection in .env would make
# the pinned `-p agent-tasks -f .../compose.yaml` selection ambiguous. Reject the
# keys without printing their values.
for override in compose.override.yaml compose.override.yml docker-compose.override.yaml docker-compose.override.yml; do
  [ ! -e "$override" ] ||
    fail "$REMOTE_DIR/$override exists; remove it, the deploy pins compose.yaml explicitly"
done
if grep -Eq '^[[:space:]]*(export[[:space:]]+)?COMPOSE_FILE[[:space:]]*=' .env; then
  fail "$REMOTE_DIR/.env sets COMPOSE_FILE; remove it so the deploy's explicit -f selection is authoritative"
fi
if grep -Eq '^[[:space:]]*(export[[:space:]]+)?COMPOSE_PROJECT_NAME[[:space:]]*=' .env; then
  fail "$REMOTE_DIR/.env sets COMPOSE_PROJECT_NAME; remove it so the project stays agent-tasks"
fi
printf 'prereq: host directory, .env metadata and Compose selection are valid\n'
REMOTE
}

remote_assets() {
  cat <<'REMOTE'
set -eu
cd "$REMOTE_DIR"

fail() {
  printf 'deploy assets: %s\n' "$*" >&2
  exit 1
}

[ ! -L "$REMOTE_DIR/docker" ] || fail "$REMOTE_DIR/docker must not be a symlink"
install -d -m 0755 "$REMOTE_DIR/docker"
# A stale staging path must not be a symlink that rsync would follow.
for staged in "$REMOTE_DIR/compose.yaml.next" "$REMOTE_DIR/docker/seccomp-browser.json.next"; do
  [ ! -L "$staged" ] || fail "$staged must not be a symlink"
done
printf 'assets: %s\n' "$REMOTE_DIR/docker"
REMOTE
}

remote_seccomp_state() {
  cat <<'REMOTE'
set -eu
path="$REMOTE_DIR/docker/seccomp-browser.json"
# deploy-seccomp-state: the deploy compares this with the local staged bytes.
if [ -L "$path" ]; then
  printf 'state: symlink\n'
  exit 0
fi
if [ ! -f "$path" ]; then
  printf 'state: missing\n'
  exit 0
fi
if command -v sha256sum >/dev/null 2>&1; then
  digest=$(sha256sum "$path" | cut -d' ' -f1)
elif command -v shasum >/dev/null 2>&1; then
  digest=$(shasum -a 256 "$path" | cut -d' ' -f1)
else
  printf 'state: unknown\n'
  exit 0
fi
printf 'state: %s\n' "$digest"
REMOTE
}

remote_preflight() {
  cat <<'REMOTE'
set -eu

fail() {
  printf 'deploy preflight: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "the Docker CLI is not available on the host"
command -v python3 >/dev/null 2>&1 ||
  fail "python3 is required on the host to validate the effective Compose configuration without printing secrets"

cd "$REMOTE_DIR" || fail "$REMOTE_DIR is not accessible"
[ -f compose.yaml.next ] || fail "$REMOTE_DIR/compose.yaml.next is missing after staging"
[ ! -L compose.yaml.next ] || fail "$REMOTE_DIR/compose.yaml.next must not be a symlink"
[ -f .env ] || fail "$REMOTE_DIR/.env is missing"
[ ! -L .env ] || fail "$REMOTE_DIR/.env must be a regular file, not a symlink"
owner_mode=$(stat -c '%U:%G %a' .env)
[ "$owner_mode" = "root:root 600" ] ||
  fail "$REMOTE_DIR/.env must be root:root 0600 (found $owner_mode)"
for override in compose.override.yaml compose.override.yml docker-compose.override.yaml docker-compose.override.yml; do
  [ ! -e "$override" ] ||
    fail "$REMOTE_DIR/$override exists; remove it, the deploy pins compose.yaml explicitly"
done
if grep -Eq '^[[:space:]]*(export[[:space:]]+)?COMPOSE_FILE[[:space:]]*=' .env; then
  fail "$REMOTE_DIR/.env sets COMPOSE_FILE; remove it so the deploy's explicit -f selection is authoritative"
fi
if grep -Eq '^[[:space:]]*(export[[:space:]]+)?COMPOSE_PROJECT_NAME[[:space:]]*=' .env; then
  fail "$REMOTE_DIR/.env sets COMPOSE_PROJECT_NAME; remove it so the project stays agent-tasks"
fi

# Compose owns the interpretation of .env (quoting, inline comments, variable
# interpolation). Render the file once and hand the result directly to a parser
# that prints only symbolic pass/fail reasons, never the values themselves.
parser=$(mktemp) || fail "mktemp is required on the host"
trap 'rm -f "$parser"' EXIT HUP INT TERM
cat > "$parser" <<'PY'
import base64
import json
import sys
import urllib.parse

expected_seccomp = sys.argv[1] if len(sys.argv) > 1 else ""


def fail(code):
    print("fail " + code)
    sys.exit(1)


try:
    document = json.load(sys.stdin)
except Exception:
    fail("configuration:unreadable")

if not isinstance(document, dict):
    fail("configuration:unreadable")
if document.get("name") != "agent-tasks":
    fail("project:wrong")

services = document.get("services")
if not isinstance(services, dict):
    fail("configuration:unreadable")


def service(name):
    value = services.get(name)
    return value if isinstance(value, dict) else {}


def environment(name):
    value = service(name).get("environment")
    return value if isinstance(value, dict) else {}


def text(mapping, key):
    value = mapping.get(key)
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def placeholder(value):
    lowered = value.lower()
    return (
        "replace-with" in lowered
        or "change-me" in lowered
        or "__generate__" in lowered
    )


def require(mapping, key):
    value = text(mapping, key)
    if value == "":
        fail(key + ":empty")
    if placeholder(value):
        fail(key + ":placeholder")
    return value


api = environment("api")
postgres = environment("postgres")

postgres_password = require(postgres, "POSTGRES_PASSWORD")
if postgres_password in ("agent", "postgres"):
    fail("POSTGRES_PASSWORD:default")

# The rendered mount, not just the project name, must keep the existing database
# volume. A coordinated rename of the project or volume would otherwise let `up`
# create an empty volume and silently start a fresh database.
postgres_volume_name = ""
postgres_volumes = service("postgres").get("volumes")
postgres_volumes = postgres_volumes if isinstance(postgres_volumes, list) else []
for volume in postgres_volumes:
    if isinstance(volume, dict) and volume.get("target") == "/var/lib/postgresql/data":
        if volume.get("type") == "volume":
            source = str(volume.get("source") or "")
            named_volumes = document.get("volumes")
            named_volumes = named_volumes if isinstance(named_volumes, dict) else {}
            definition = named_volumes.get(source)
            if isinstance(definition, dict):
                postgres_volume_name = str(definition.get("name") or "")
        else:
            postgres_volume_name = "not-a-named-volume"
if postgres_volume_name != "agent-tasks_postgres-data":
    fail("POSTGRES_VOLUME:name")

# The optional mail profile publishes Mailpit on every host interface. The
# OpenCode profile mounts the Docker socket and enables provider egress; both
# remain disabled in production until their respective configuration is approved.
for name in services:
    profiles = service(name).get("profiles")
    profiles = profiles if isinstance(profiles, list) else []
    if "mail" in profiles or name in ("mailpit", "spamassassin"):
        fail("MAIL:unsupported")
    if "opencode-runtime" in profiles or name == "opencode-provisioner":
        fail("OPENCODE_RUNTIME:unsupported")

auth_secret = require(api, "AUTH_SECRET")
if len(auth_secret) < 32:
    fail("AUTH_SECRET:short")

encryption_key = require(api, "SECRETS_ENCRYPTION_KEY")
try:
    decoded_key = base64.b64decode(encryption_key, validate=True)
except Exception:
    fail("SECRETS_ENCRYPTION_KEY:invalid")
if len(decoded_key) != 32:
    fail("SECRETS_ENCRYPTION_KEY:invalid")

# RUNNER_TOKEN belongs to the worker and the browser runner. The API must not
# receive it, and both consuming services must agree or every execution fails
# with a 401 from the runner.
worker = environment("worker")
browser_runner = environment("browser-runner")
runner_token = require(worker, "RUNNER_TOKEN")
if len(runner_token) < 16:
    fail("RUNNER_TOKEN:short")
runner_token_runner = require(browser_runner, "RUNNER_TOKEN")
if len(runner_token_runner) < 16:
    fail("RUNNER_TOKEN:short")
if runner_token != runner_token_runner:
    fail("RUNNER_TOKEN:mismatch")
if text(api, "RUNNER_TOKEN") != "":
    fail("RUNNER_TOKEN:wrong-service")

# The worker has no non-OpenCode execution path: an empty provisioner token makes
# it exit at startup, before queue registration. Refuse the deploy instead of
# leaving a restart loop on the host. Enabling the token also requires the
# profile, which the profile check above rejects until the gates pass.
provisioner_token = text(worker, "OPENCODE_PROVISIONER_TOKEN")
if provisioner_token == "":
    fail("OPENCODE_PROVISIONER_TOKEN:runtime-disabled")
if placeholder(provisioner_token):
    fail("OPENCODE_PROVISIONER_TOKEN:placeholder")
if len(provisioner_token) < 32:
    fail("OPENCODE_PROVISIONER_TOKEN:short")

public_url = require(api, "PUBLIC_BASE_URL")
try:
    parsed_url = urllib.parse.urlsplit(public_url)
    parsed_url.port
except ValueError:
    fail("PUBLIC_BASE_URL:malformed")
if parsed_url.scheme.lower() != "https":
    fail("PUBLIC_BASE_URL:not-https")
public_host = parsed_url.hostname or ""
if public_host == "" or any(character.isspace() for character in public_host):
    fail("PUBLIC_BASE_URL:hostless")
public_host = public_host.lower()
if (
    public_host in ("localhost", "127.0.0.1", "::1", "0.0.0.0")
    or public_host == "example.com"
    or public_host.endswith(".example.com")
):
    fail("PUBLIC_BASE_URL:placeholder")

if text(api, "COOKIE_SECURE") != "true":
    fail("COOKIE_SECURE:not-true")
if text(api, "TRUST_PROXY") != "true":
    fail("TRUST_PROXY:not-true")

setup_token = text(api, "SETUP_TOKEN")
if setup_token != "":
    if placeholder(setup_token):
        fail("SETUP_TOKEN:placeholder")
    if len(setup_token) < 16:
        fail("SETUP_TOKEN:short")

admin_email = text(api, "ADMIN_EMAIL")
admin_password = text(api, "ADMIN_PASSWORD")
if admin_email != "" or admin_password != "":
    if admin_email == "" or admin_password == "":
        fail("ADMIN:incomplete")
    if placeholder(admin_email) or admin_email.lower().endswith("@example.com"):
        fail("ADMIN_EMAIL:placeholder")
    if placeholder(admin_password):
        fail("ADMIN_PASSWORD:placeholder")
    if len(admin_password) < 12:
        fail("ADMIN_PASSWORD:short")
elif setup_token == "":
    print("warn no-bootstrap")

security_options = service("browser-runner").get("security_opt")
security_options = security_options if isinstance(security_options, list) else []
seccomp_path = ""
for option in security_options:
    if isinstance(option, str) and option.startswith("seccomp="):
        seccomp_path = option[len("seccomp=") :]
        break
if seccomp_path == "":
    fail("seccomp:missing")
if not seccomp_path.startswith("/"):
    fail("seccomp:not-absolute")
if seccomp_path != expected_seccomp:
    print("warn seccomp-override")

searxng = services.get("searxng")
if isinstance(searxng, dict):
    settings_path = ""
    volumes = searxng.get("volumes")
    volumes = volumes if isinstance(volumes, list) else []
    for volume in volumes:
        if isinstance(volume, dict) and volume.get("target") == "/etc/searxng/settings.yml":
            settings_path = str(volume.get("source") or "")
        elif isinstance(volume, str) and volume.endswith(":/etc/searxng/settings.yml:ro"):
            settings_path = volume.split(":", 1)[0]
    if settings_path == "":
        fail("SEARXNG_SETTINGS_PATH:missing")
    if not settings_path.startswith("/"):
        fail("SEARXNG_SETTINGS_PATH:not-absolute")
    print("settings " + settings_path)
else:
    print("search inactive")
PY

effective_report=$(
  RUNNER_SECCOMP_PATH="$REMOTE_DIR/docker/seccomp-browser.json" \
    docker compose -p agent-tasks --env-file "$REMOTE_DIR/.env" -f "$REMOTE_DIR/compose.yaml.next" config --format json 2>/dev/null |
    python3 "$parser" "$REMOTE_DIR/docker/seccomp-browser.json"
) || {
  code=$(printf '%s\n' "$effective_report" | sed -n 's/^fail //p' | head -n 1)
  [ -n "$code" ] || code="configuration:unreadable"
  key=${code%%:*}
  reason=${code#*:}
  case "$code" in
    configuration:unreadable)
      fail "docker compose could not render compose.yaml.next with the host .env; run 'docker compose -p agent-tasks --env-file $REMOTE_DIR/.env -f $REMOTE_DIR/compose.yaml.next config -q' on the host as root"
      ;;
  esac
  case "$reason" in
    empty) fail "$key is missing or empty in the effective Compose configuration" ;;
    placeholder) fail "$key still contains a placeholder value in the effective Compose configuration" ;;
    default) fail "$key must not use the development default" ;;
    short) fail "$key is too short in the effective Compose configuration" ;;
    invalid) fail "$key is not valid in the effective Compose configuration" ;;
    not-https) fail "$key must be an https:// URL in production" ;;
    hostless) fail "$key must include a host name (https:// and other hostless values are rejected)" ;;
    malformed) fail "$key is not a valid URL" ;;
    not-true) fail "$key must be true in production" ;;
    incomplete) fail "ADMIN_EMAIL and ADMIN_PASSWORD must be set together in the effective Compose configuration" ;;
    not-absolute) fail "$key must be an absolute path on the host" ;;
    missing) fail "$key is missing from the effective Compose configuration" ;;
    wrong) fail "$key must be agent-tasks (the deploy pins -p agent-tasks)" ;;
    mismatch) fail "$key must be identical on worker and browser-runner in the effective Compose configuration" ;;
    wrong-service) fail "$key must be set on worker and browser-runner only, never on api" ;;
    runtime-disabled) fail "$key is empty: the isolated runtime is disabled in production, so the worker would exit before queue registration. Production deploys stay blocked until the verification gates pass (docs/architecture/opencode-runtime-isolation.md)" ;;
    name) fail "$key must resolve to the Docker volume agent-tasks_postgres-data mounted at /var/lib/postgresql/data; a different name would start an empty database" ;;
    unsupported)
      case "$key" in
        MAIL) fail "the mail profile must not be active in production; Mailpit publishes ports on all interfaces, use SMTP_URL with an external relay instead" ;;
        OPENCODE_RUNTIME) fail "the OpenCode runtime profile must remain disabled in production until the documented provider, egress, MCP and credential verification gates pass" ;;
      esac
      ;;
    *) fail "the effective Compose configuration is invalid ($code)" ;;
  esac
}

settings_path=""
while IFS= read -r line; do
  [ -n "$line" ] || continue
  tag=${line%% *}
  rest=${line#* }
  case "$tag" in
    warn)
      case "$rest" in
        no-bootstrap)
          printf 'deploy preflight: neither SETUP_TOKEN nor ADMIN_EMAIL/ADMIN_PASSWORD is set; first-admin bootstrap is unavailable (an existing admin is required)\n' >&2
          ;;
        seccomp-override)
          printf 'deploy preflight: RUNNER_SECCOMP_PATH in .env is overridden by the deploy-managed profile %s\n' \
            "$REMOTE_DIR/docker/seccomp-browser.json" >&2
          ;;
      esac
      ;;
    settings) settings_path=$rest ;;
  esac
done <<REPORT
$effective_report
REPORT

if [ -n "$settings_path" ]; then
  case "$settings_path" in
    /*) ;;
    *) fail "SEARXNG_SETTINGS_PATH must be an absolute path on the host" ;;
  esac
  [ -f "$settings_path" ] ||
    fail "search profile is active but $settings_path is missing; create the host-only settings file with a generated secret"
  [ ! -L "$settings_path" ] ||
    fail "$settings_path must be a regular host file, not a symlink"
  if grep -q 'change-me-in-production' "$settings_path"; then
    fail "$settings_path still contains the placeholder server.secret_key"
  fi
  grep -Eq '^[[:space:]]*secret_key:[[:space:]]*[^[:space:]]' "$settings_path" ||
    fail "$settings_path has no server.secret_key"
  settings_owner_mode=$(stat -c '%U:%G %a' "$settings_path")
  [ "$settings_owner_mode" = "root:root 600" ] ||
    fail "$settings_path must be root:root 0600 (found $settings_owner_mode)"
fi

docker network inspect webnet >/dev/null 2>&1 ||
  fail "external Docker network 'webnet' is missing; it must be created by the Caddy/proxy stack with subnet 172.18.0.0/16 and gateway 172.18.0.1"
ipam=$(docker network inspect webnet --format '{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{"\n"}}{{end}}')
webnet_ok=0
while IFS=' ' read -r subnet gateway rest; do
  [ -n "$subnet" ] || continue
  if [ "$subnet" = "172.18.0.0/16" ] && [ "$gateway" = "172.18.0.1" ]; then
    webnet_ok=1
  else
    fail "webnet IPAM entry '$subnet $gateway' is not the required 172.18.0.0/16 with gateway 172.18.0.1; 0.0.0.0/0 is rejected"
  fi
done <<EOF
$ipam
EOF
[ "$webnet_ok" -eq 1 ] ||
  fail "webnet has no IPAM subnet 172.18.0.0/16 with gateway 172.18.0.1"

printf 'deploy preflight: effective configuration, webnet and host assets are valid\n'
REMOTE
}

remote_backup() {
  cat <<'REMOTE'
set -eu
cd "$REMOTE_DIR"

fail() {
  printf 'deploy backup: %s\n' "$*" >&2
  exit 1
}

umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_root="$REMOTE_DIR/backups"
backup_dir="$backup_root/$stamp"
[ ! -L "$backup_root" ] || fail "$backup_root must not be a symlink"
install -d -m 0700 "$backup_root"
chmod 0700 "$backup_root"
[ ! -e "$backup_dir" ] || fail "backup directory already exists: $backup_dir"
install -d -m 0700 "$backup_dir"

cp -p .env "$backup_dir/env"
chmod 0600 "$backup_dir/env"

# Pin the project and file on every Compose call. The `ps`/`exec` checks must
# inspect the same project that `up` reconciles, even if the host .env or the
# caller's environment carries stale COMPOSE_* defaults.
dumped=0
if [ -f compose.yaml ]; then
  container=$(docker compose -p agent-tasks --env-file "$REMOTE_DIR/.env" -f "$REMOTE_DIR/compose.yaml" ps -q postgres 2>/dev/null || true)
  if [ -n "$container" ]; then
    running=$(docker inspect -f '{{.State.Running}}' "$container")
    if [ "$running" = "true" ]; then
      docker compose -p agent-tasks --env-file "$REMOTE_DIR/.env" -f "$REMOTE_DIR/compose.yaml" exec -T postgres sh -c \
        'pg_dump -U "$POSTGRES_USER" --clean --if-exists "$POSTGRES_DB"' \
        > "$backup_dir/postgres.sql"
      [ -s "$backup_dir/postgres.sql" ] ||
        fail "pg_dump produced an empty file; the deploy was stopped before any container changed"
      gzip -c "$backup_dir/postgres.sql" > "$backup_dir/postgres.sql.gz"
      rm -f "$backup_dir/postgres.sql"
      gzip -t "$backup_dir/postgres.sql.gz" ||
        fail "the database backup archive is invalid; the deploy was stopped"
      dumped=1
    fi
  fi
fi

if [ "$dumped" -eq 0 ]; then
  if docker volume inspect agent-tasks_postgres-data >/dev/null 2>&1; then
    if [ "${DB_BACKUP_CONFIRM:-}" = "backed-up" ]; then
      printf 'backup: existing Postgres volume is stopped; using the operator-confirmed prior dump\n'
    else
      fail "agent-tasks_postgres-data exists but postgres is not running; start it (docker compose -p agent-tasks --env-file $REMOTE_DIR/.env -f $REMOTE_DIR/compose.yaml up -d postgres) or take the documented pg_dump backup and rerun with DEPLOY_DB_BACKUP_CONFIRM=backed-up"
    fi
  else
    printf 'backup: no existing Postgres volume; database dump not needed (first deploy)\n'
  fi
fi
printf 'backup: %s\n' "$backup_dir"
REMOTE
}

remote_promote() {
  cat <<'REMOTE'
set -eu
cd "$REMOTE_DIR"

fail() {
  printf 'deploy promote: %s\n' "$*" >&2
  exit 1
}

[ -f compose.yaml.next ] || fail "$REMOTE_DIR/compose.yaml.next is missing after staging"
[ -f docker/seccomp-browser.json.next ] ||
  fail "$REMOTE_DIR/docker/seccomp-browser.json.next is missing after staging"
[ ! -L compose.yaml ] || fail "$REMOTE_DIR/compose.yaml must not be a symlink"
[ ! -L docker/seccomp-browser.json ] ||
  fail "$REMOTE_DIR/docker/seccomp-browser.json must not be a symlink"

# Seccomp first: the promoted compose file references the final profile path.
mv -f docker/seccomp-browser.json.next docker/seccomp-browser.json
mv -f compose.yaml.next compose.yaml
chmod 0644 compose.yaml docker/seccomp-browser.json
printf 'promote: staged compose file and seccomp profile are active\n'
REMOTE
}

remote_validation() {
  cat <<'REMOTE'
set -eu
cd "$REMOTE_DIR"

fail() {
  printf 'deploy validation: %s\n' "$*" >&2
  exit 1
}

[ -f compose.yaml ] || fail "$REMOTE_DIR/compose.yaml is missing after promotion"
[ ! -L compose.yaml ] || fail "$REMOTE_DIR/compose.yaml must not be a symlink"
[ -s "$REMOTE_DIR/docker/seccomp-browser.json" ] ||
  fail "$REMOTE_DIR/docker/seccomp-browser.json is missing after promotion"

seccomp_path="$REMOTE_DIR/docker/seccomp-browser.json"
[ -f "$seccomp_path" ] || fail "the staged seccomp profile does not exist: $seccomp_path"

RUNNER_SECCOMP_PATH="$seccomp_path" \
  docker compose -p agent-tasks --env-file "$REMOTE_DIR/.env" -f "$REMOTE_DIR/compose.yaml" config -q ||
  fail "Compose rejected the host compose file"
printf 'validation: compose file and seccomp profile are present and valid\n'
REMOTE
}

run_remote_script prereq "$(remote_prereq)"
run_remote_script assets "$(remote_assets)"

# Read the old staged bytes before replacing anything. Compose only notices a
# changed seccomp file when the container is force-recreated, so remember
# whether that single service must be recreated later.
seccomp_state_script=$(remote_seccomp_state)
if [ "$dry_run" -eq 1 ]; then
  print_remote_script seccomp "$seccomp_state_script"
  remote_seccomp_state="unknown"
else
  seccomp_state_output=$(printf '%s\n' "$seccomp_state_script" | ssh "${ssh_opts[@]}" "$host" \
    "REMOTE_DIR='${remote_dir}' DB_BACKUP_CONFIRM='${backup_confirm}' sh -s")
  remote_seccomp_state=$(printf '%s\n' "$seccomp_state_output" |
    sed -n 's/^state: //p' | tail -n 1)
fi
if [ "$remote_seccomp_state" = "symlink" ]; then
  echo "deploy: ${remote_dir}/docker/seccomp-browser.json must not be a symlink" >&2
  exit 1
fi
if [ "$remote_seccomp_state" = "$local_seccomp_hash" ]; then
  recreate_runner=0
else
  recreate_runner=1
fi

# Stage new files under .next; the active compose.yaml stays untouched until the
# preflight has validated the effective .env values and the host prerequisites.
run rsync -q -e "ssh ${ssh_opts[*]}" "$local_seccomp" \
  "${host}:${remote_dir}/docker/seccomp-browser.json.next"
run rsync -q -e "ssh ${ssh_opts[*]}" "$local_compose" \
  "${host}:${remote_dir}/compose.yaml.next"

run_remote_script preflight "$(remote_preflight)"
run_remote_script backup "$(remote_backup)"
run_remote_script promote "$(remote_promote)"
run_remote_script validation "$(remote_validation)"

# A changed seccomp profile is invisible to Compose. Recreate only the runner
# before the general reconcile; the profile path is pinned for both commands so
# a stale .env override cannot select a missing host file.
if [ "$recreate_runner" -eq 1 ]; then
  if [ "$dry_run" -eq 1 ]; then
    printf 'dry-run: staged seccomp profile differs or is missing; browser-runner would be recreated\n'
  else
    printf 'deploy: staged seccomp profile changed; recreating browser-runner only\n'
  fi
  # shellcheck disable=SC2029 # remote_dir, remote_seccomp are fixed local constants
  run ssh "${ssh_opts[@]}" "$host" \
    "cd '${remote_dir}' && RUNNER_SECCOMP_PATH='${remote_seccomp}' docker compose -p ${compose_project} --env-file '${remote_dir}/.env' -f '${remote_compose}' up -d --no-deps --force-recreate --wait --wait-timeout ${wait_timeout} browser-runner"
fi

# shellcheck disable=SC2029 # remote_dir, remote_compose are fixed local constants
run ssh "${ssh_opts[@]}" "$host" \
  "cd '${remote_dir}' && RUNNER_SECCOMP_PATH='${remote_seccomp}' docker compose -p ${compose_project} --env-file '${remote_dir}/.env' -f '${remote_compose}' up -d --wait --wait-timeout ${wait_timeout}"

if [ "$dry_run" -eq 0 ]; then
  # shellcheck disable=SC2029 # remote_dir, remote_compose are fixed local constants
  ssh "${ssh_opts[@]}" "$host" \
    "cd '${remote_dir}' && docker compose -p ${compose_project} --env-file '${remote_dir}/.env' -f '${remote_compose}' ps"
fi
