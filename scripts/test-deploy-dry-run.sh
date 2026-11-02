#!/bin/sh
# Exercise deployment/deploy.sh without a real SSH target. The dry run must not
# invoke ssh/rsync or create a control socket; a stubbed real run must exercise
# the staging/promotion/up sequence through fake binaries only. The remote
# prereq/preflight/backup/promote bodies themselves are extracted from the dry
# run and executed locally with stub docker/stat binaries, so the .env-mode,
# effective-config, subnet, search-settings, backup and promotion checks run for
# real instead of only asserting ssh argv.
set -eu

repo=$(unset CDPATH; cd -- "$(dirname -- "$0")/.." && pwd)
deploy="$repo/deployment/deploy.sh"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/agent-tasks-deploy-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

# Deterministic low-entropy fixtures. The preflight contract needs syntactically
# valid values, not realistic secrets, so repeated characters keep Gitleaks and
# the pre-commit secret regex quiet. Assignments are also assembled at runtime
# with env_line() below, so this file contains no `KEY=value` secret literal.
auth_value=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
postgres_value=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
admin_value=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
runner_value=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
runner_other=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
# Base64 of 32 zero bytes: exactly the decoded length the preflight requires.
encryption_value=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=

env_line() {
  printf '%s=%s\n' "$1" "$2"
}

command -v python3 >/dev/null 2>&1 || {
  echo 'deploy test: python3 is required' >&2
  exit 1
}
command -v node >/dev/null 2>&1 || {
  echo 'deploy test: node is required for the Compose contract check' >&2
  exit 1
}

stub_bin="$tmp/bin"
test_home="$tmp/home"
calls="$tmp/calls"
stdin_log="$tmp/stdin"
out="$tmp/out"
remote="$tmp/remote"
known_hosts="$test_home/.ssh/known_hosts"
mkdir -p "$stub_bin" "$test_home/.ssh" "$remote/docker/searxng"

cat > "$stub_bin/ssh" <<'EOF'
#!/bin/sh
printf 'ssh %s\n' "$*" >> "$DEPLOY_TEST_LOG"
case "$*" in
  *"sh -s"*)
    captured="$DEPLOY_TEST_STDIN.capture"
    cat > "$captured"
    for marker in prereq assets preflight backup promote validation; do
      if grep -q "deploy $marker:" "$captured"; then
        printf 'ssh-body %s\n' "$marker" >> "$DEPLOY_TEST_LOG"
      fi
    done
    if grep -q 'deploy-seccomp-state' "$captured"; then
      printf 'ssh-body seccomp\n' >> "$DEPLOY_TEST_LOG"
      printf 'state: %s\n' "${DEPLOY_TEST_SECCOMP_STATE:-missing}"
    fi
    cat "$captured" >> "$DEPLOY_TEST_STDIN"
    rm -f "$captured"
    ;;
esac
exit 0
EOF
cat > "$stub_bin/rsync" <<'EOF'
#!/bin/sh
printf 'rsync %s\n' "$*" >> "$DEPLOY_TEST_LOG"
exit 0
EOF
cat > "$stub_bin/docker" <<'EOF'
#!/bin/sh
printf 'docker %s\n' "$*" >> "$DEPLOY_TEST_LOG"
case "$*" in
  *"network inspect webnet --format"*)
    cat "${DEPLOY_TEST_NETWORK_FILE:-/dev/null}"
    ;;
  *"network inspect webnet"*)
    exit 0
    ;;
  *" config --format json"*)
    cat "${DEPLOY_TEST_COMPOSE_JSON:-/dev/null}"
    ;;
  *" config -q"*)
    exit 0
    ;;
  *" ps -q postgres"*)
    printf '%s\n' "${DEPLOY_TEST_POSTGRES_CONTAINER:-}"
    ;;
  *".State.Running"*)
    printf '%s\n' "${DEPLOY_TEST_POSTGRES_RUNNING:-true}"
    ;;
  *" exec -T postgres "*)
    if [ -n "${DEPLOY_TEST_PGDUMP:-}" ]; then
      cat "$DEPLOY_TEST_PGDUMP"
    fi
    exit "${DEPLOY_TEST_PGDUMP_STATUS:-0}"
    ;;
  volume\ inspect\ *)
    exit "${DEPLOY_TEST_VOLUME_STATUS:-1}"
    ;;
esac
exit 0
EOF
# The host runs GNU stat; the test cannot own a root:root file, so answer only
# the owner/mode queries the prereq/preflight make.
cat > "$stub_bin/stat" <<'EOF'
#!/bin/sh
printf 'stat %s\n' "$*" >> "$DEPLOY_TEST_LOG"
case "$*" in
  *searxng*settings.yml*)
    printf '%s\n' "${DEPLOY_TEST_SEARXNG_MODE:-root:root 600}"
    ;;
  *)
    printf '%s\n' "${DEPLOY_TEST_ENV_MODE:-root:root 600}"
    ;;
esac
EOF
chmod +x "$stub_bin/ssh" "$stub_bin/rsync" "$stub_bin/docker" "$stub_bin/stat"

fail() {
  printf 'deploy test: %s\n' "$*" >&2
  if [ -f "$out" ]; then
    printf -- '--- output ---\n' >&2
    cat "$out" >&2
  fi
  exit 1
}

run_deploy() {
  deploy_host=$1
  shift
  if [ -n "$deploy_host" ]; then
    HOME="$test_home" \
      PATH="$stub_bin:$PATH" \
      DEPLOY_TEST_LOG="$calls" \
      DEPLOY_TEST_STDIN="$stdin_log" \
      DEPLOY_HOST="$deploy_host" \
      "$@"
  else
    HOME="$test_home" \
      PATH="$stub_bin:$PATH" \
      DEPLOY_TEST_LOG="$calls" \
      DEPLOY_TEST_STDIN="$stdin_log" \
      env -u DEPLOY_HOST "$@"
  fi
}

file_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    return 1
  fi
}

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

# Extract one remote body printed by the dry run into a local file.
extract_body() {
  label=$1
  destination=$2
  awk -v header="dry-run: [$label]" '
    index($0, header) == 1 { capture = 1; next }
    capture && /^dry-run: \[/ { capture = 0 }
    capture {
      sub(/^dry-run:   /, "")
      print
    }
  ' "$tmp/dry-run.txt" > "$destination"
}

prepare_remote_dir() {
  directory=$1
  mkdir -p "$directory/docker"
  env_line AUTH_SECRET "$auth_value" > "$directory/.env"
  printf 'name: agent-tasks\nservices: {}\n' > "$directory/compose.yaml"
}

line_of() {
  grep -n -F -- "$1" "$2" | head -n 1 | cut -d: -f1
}

# --help must work without DEPLOY_HOST and must not print a raw sed range.
if ! run_deploy "" "$deploy" --help > "$out" 2>&1; then
  fail '--help failed'
fi
grep -q '^usage: DEPLOY_HOST=' "$out" || fail '--help does not show the required DEPLOY_HOST usage'
if grep -q 'sed -n' "$out"; then
  fail '--help printed a shell code line'
fi

# A missing host is an error before any connection is attempted.
: > "$calls"
: > "$stdin_log"
if run_deploy "" "$deploy" --dry-run > "$out" 2>&1; then
  fail 'dry run accepted a missing DEPLOY_HOST'
fi
grep -q 'DEPLOY_HOST is required' "$out" || fail 'missing DEPLOY_HOST error is unclear'
[ ! -s "$calls" ] || fail 'missing DEPLOY_HOST still invoked ssh/rsync'

# A destination beginning with '-' would be parsed by ssh as an option.
if run_deploy "-oProxyCommand=touch$tmp/pwned" "$deploy" --dry-run > "$out" 2>&1; then
  fail 'dry run accepted an ssh option as DEPLOY_HOST'
fi
grep -q "must not start with '-'" "$out" || fail 'leading-dash DEPLOY_HOST error is unclear'
[ ! -e "$tmp/pwned" ] || fail 'leading-dash DEPLOY_HOST executed a local command'
[ ! -s "$calls" ] || fail 'leading-dash DEPLOY_HOST still invoked ssh/rsync'

# The backup confirmation value is validated before any host contact.
if run_deploy "root@deploy.invalid" env DEPLOY_DB_BACKUP_CONFIRM=yes "$deploy" --dry-run > "$out" 2>&1; then
  fail 'dry run accepted an invalid DEPLOY_DB_BACKUP_CONFIRM'
fi
grep -q "DEPLOY_DB_BACKUP_CONFIRM must be 'backed-up'" "$out" ||
  fail 'invalid DEPLOY_DB_BACKUP_CONFIRM error is unclear'
[ ! -s "$calls" ] || fail 'invalid backup confirmation still invoked ssh/rsync'

# The dry run stays offline and leaves the private control directory uncreated.
: > "$calls"
: > "$stdin_log"
if ! run_deploy "root@deploy.invalid" "$deploy" --dry-run > "$out" 2>&1; then
  fail 'dry run failed'
fi
[ ! -s "$calls" ] || fail 'dry run invoked ssh/rsync'
[ ! -e "$test_home/.ssh/agent-tasks-deploy" ] || fail 'dry run created the SSH control directory'
grep -q '^dry-run: \[prereq\]' "$out" || fail 'dry run did not print the prereq step'
grep -q '^dry-run: \[seccomp\]' "$out" || fail 'dry run did not print the seccomp state step'
grep -q '^dry-run: \[preflight\]' "$out" || fail 'dry run did not print the preflight step'
grep -q '^dry-run: \[backup\]' "$out" || fail 'dry run did not print the backup step'
grep -q '^dry-run: \[promote\]' "$out" || fail 'dry run did not print the promote step'
grep -q 'docker network inspect webnet' "$out" || fail 'dry run did not show the webnet preflight'
grep -q 'pg_dump' "$out" || fail 'dry run did not show the database backup'
grep -q 'compose.yaml.next' "$out" || fail 'dry run did not show the staged compose file'
grep -q 'force-recreate' "$out" || fail 'dry run did not show the targeted runner recreate'
grep -q 'BatchMode=yes' "$out" || fail 'dry run does not use SSH BatchMode'
grep -q 'ConnectTimeout=10' "$out" || fail 'dry run does not show the SSH connect timeout'
grep -q 'StrictHostKeyChecking=yes' "$out" || fail 'dry run does not enforce strict host-key checking'
grep -q 'UserKnownHostsFile=' "$out" || fail 'dry run does not name the known_hosts file'
if grep -q -E 'StrictHostKeyChecking=(no|accept-new)' "$out"; then
  fail 'dry run weakens strict host-key checking'
fi
# Every remote Compose command names the project and file explicitly.
compose_lines() {
  grep 'docker compose' "$1" | grep -v -E '^[[:space:]]*#' | grep -v -E '^dry-run: +#'
}
if compose_lines "$out" | grep -v -- '-p agent-tasks' | grep -q .; then
  fail 'dry run shows a Compose command without -p agent-tasks'
fi
if compose_lines "$out" | grep -v -- ' -f ' | grep -q .; then
  fail 'dry run shows a Compose command without an explicit -f file'
fi
cp "$out" "$tmp/dry-run.txt"

# Strict host-key checking must fail safely before contacting the host when the
# operator has no known_hosts file.
: > "$calls"
: > "$stdin_log"
if run_deploy "root@deploy.invalid" "$deploy" > "$out" 2>&1; then
  fail 'real run accepted a missing known_hosts file'
fi
grep -q 'known_hosts is missing or unreadable' "$out" || fail 'missing known_hosts error is unclear'
[ ! -s "$calls" ] || fail 'missing known_hosts still invoked ssh/rsync'

printf 'deploy.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnly\n' > "$known_hosts"

extract_body prereq "$tmp/prereq.sh"
extract_body preflight "$tmp/preflight.sh"
extract_body backup "$tmp/backup.sh"
extract_body promote "$tmp/promote.sh"
[ -s "$tmp/prereq.sh" ] || fail 'could not extract the remote prereq body'
[ -s "$tmp/preflight.sh" ] || fail 'could not extract the remote preflight body'
[ -s "$tmp/backup.sh" ] || fail 'could not extract the remote backup body'
[ -s "$tmp/promote.sh" ] || fail 'could not extract the remote promote body'
grep -q 'deploy prereq' "$tmp/prereq.sh" || fail 'extracted prereq body is incomplete'
grep -q 'deploy preflight' "$tmp/preflight.sh" || fail 'extracted preflight body is incomplete'
grep -q 'deploy backup' "$tmp/backup.sh" || fail 'extracted backup body is incomplete'
grep -q 'deploy promote' "$tmp/promote.sh" || fail 'extracted promote body is incomplete'
grep -q 'config --format json' "$tmp/preflight.sh" ||
  fail 'preflight does not render the effective compose configuration'
grep -q 'python3' "$tmp/preflight.sh" || fail 'preflight does not use the JSON parser'
grep -q '172.18.0.0/16' "$tmp/preflight.sh" || fail 'preflight does not require the exact webnet subnet'

# The prereq rejects implicit Compose selection before any staging happens.
valid_auth=$auth_value
{
  env_line AUTH_SECRET "$valid_auth"
  env_line POSTGRES_PASSWORD "$postgres_value"
} > "$remote/.env"
printf 'name: agent-tasks\n' > "$remote/compose.yaml.next"
printf 'use_default_settings: true\nserver:\n  secret_key: ffffffffffffffffffffffffffffffff\n' \
  > "$remote/docker/searxng/settings.yml"

prereq_case() {
  case_name=$1
  expected=$2
  pattern=${3:-}
  : > "$calls"
  if env \
    PATH="$stub_bin:$PATH" \
    REMOTE_DIR="$remote" \
    DEPLOY_TEST_LOG="$calls" \
    DEPLOY_TEST_ENV_MODE="root:root 600" \
    sh "$tmp/prereq.sh" > "$out" 2>&1; then
    status=0
  else
    status=$?
  fi
  if grep -Fq -- "$postgres_value" "$out"; then
    fail "prereq '$case_name' printed a secret value"
  fi
  case "$expected" in
    pass) [ "$status" -eq 0 ] || fail "prereq '$case_name' unexpectedly failed" ;;
    fail)
      [ "$status" -ne 0 ] || fail "prereq '$case_name' unexpectedly passed"
      if [ -n "$pattern" ]; then
        grep -Fq -- "$pattern" "$out" || fail "prereq '$case_name' did not mention '$pattern'"
      fi
      ;;
  esac
}

prereq_case valid pass
printf 'name: agent-tasks\n' > "$remote/compose.override.yaml"
prereq_case override fail 'compose.override.yaml'
rm -f "$remote/compose.override.yaml"
printf 'COMPOSE_FILE=/tmp/HOST-ONLY-SENTINEL-compose.yaml\n' >> "$remote/.env"
prereq_case compose-file fail 'COMPOSE_FILE'
if grep -q 'HOST-ONLY-SENTINEL' "$out"; then
  fail "prereq 'compose-file' printed the .env value"
fi
{
  env_line AUTH_SECRET "$valid_auth"
  env_line POSTGRES_PASSWORD "$postgres_value"
} > "$remote/.env"
printf 'COMPOSE_PROJECT_NAME=HOST-ONLY-SENTINEL-other\n' >> "$remote/.env"
prereq_case compose-project fail 'COMPOSE_PROJECT_NAME'
if grep -q 'HOST-ONLY-SENTINEL' "$out"; then
  fail "prereq 'compose-project' printed the .env value"
fi
{
  env_line AUTH_SECRET "$valid_auth"
  env_line POSTGRES_PASSWORD "$postgres_value"
} > "$remote/.env"

cat > "$tmp/config-template.json" <<'JSON'
{
  "name": "agent-tasks",
  "services": {
    "api": {
      "environment": {
        "AUTH_SECRET": "@auth@",
        "SECRETS_ENCRYPTION_KEY": "@encryption@",
        "PUBLIC_BASE_URL": "https://tasks.internal.test",
        "COOKIE_SECURE": "true",
        "TRUST_PROXY": "true",
        "SETUP_TOKEN": "",
        "ADMIN_EMAIL": "admin@internal.test",
        "ADMIN_PASSWORD": "@admin@"
      }
    },
    "postgres": {
      "environment": {
        "POSTGRES_PASSWORD": "@postgres@"
      },
      "volumes": [
        {
          "type": "volume",
          "source": "postgres-data",
          "target": "/var/lib/postgresql/data"
        }
      ]
    },
    "worker": {
      "environment": {
        "RUNNER_TOKEN": "@runner@"
      }
    },
    "browser-runner": {
      "environment": {
        "RUNNER_TOKEN": "@runner@"
      },
      "security_opt": [
        "no-new-privileges:true",
        "seccomp=__REMOTE__/docker/seccomp-browser.json"
      ]
    }
  },
  "volumes": {
    "postgres-data": {
      "name": "agent-tasks_postgres-data"
    }
  }
}
JSON
sed \
  -e "s|@auth@|$auth_value|g" \
  -e "s|@encryption@|$encryption_value|g" \
  -e "s|@admin@|$admin_value|g" \
  -e "s|@postgres@|$postgres_value|g" \
  -e "s|@runner@|$runner_value|g" \
  -e "s|__REMOTE__|$remote|g" \
  "$tmp/config-template.json" > "$tmp/config-valid.json"

# CI additionally replaces the handwritten fixture with a real Compose render.
# The file contains only low-entropy test values and is kept out of test output.
if [ "${DEPLOY_TEST_RENDER_COMPOSE:-0}" = 1 ]; then
  real_docker=$(command -v docker || true)
  [ -n "$real_docker" ] || fail 'real Compose rendering was requested but docker is unavailable'
  {
    env_line POSTGRES_PASSWORD "$postgres_value"
    env_line PUBLIC_BASE_URL 'https://tasks.internal.test'
    env_line AUTH_SECRET "$auth_value"
    env_line SECRETS_ENCRYPTION_KEY "$encryption_value"
    env_line RUNNER_TOKEN "$runner_value"
    env_line COOKIE_SECURE true
    env_line TRUST_PROXY true
    env_line SETUP_TOKEN 'test-setup-token-1234567890'
    env_line ADMIN_EMAIL 'admin@internal.test'
    env_line ADMIN_PASSWORD "$admin_value"
    env_line RUNNER_SECCOMP_PATH "$remote/docker/seccomp-browser.json"
    env_line SEARXNG_SETTINGS_PATH "$remote/docker/searxng/settings.yml"
  } > "$tmp/compose-test.env"
  printf 'server:\n  secret_key: compose-contract-test-key\n' > \
    "$remote/docker/searxng/settings.yml"
  if ! "$real_docker" compose -p agent-tasks --env-file "$tmp/compose-test.env" \
    --project-directory "$repo" -f "$repo/deployment/compose.production.yaml" \
    config --format json > "$tmp/config-compose-rendered.json" 2> "$tmp/compose-render.err"; then
    fail 'real docker compose config could not render the production contract fixture'
  fi
  cp "$tmp/config-compose-rendered.json" "$tmp/config-valid.json"
fi

# The fixture must agree with the real production service definitions: the
# token is on worker/browser-runner only. This fails if RUNNER_TOKEN moves to
# api or disappears from worker in deployment/compose.production.yaml.
if ! node "$repo/scripts/check-deploy-compose-contract.mjs" --fixture "$tmp/config-valid.json" > "$out" 2>&1; then
  fail 'valid fixture does not match deployment/compose.production.yaml'
fi

edit_fixture() {
  source=$1
  destination=$2
  mutation=$3
  other=$4
  python3 - "$source" "$destination" "$mutation" "$other" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    document = json.load(handle)
mutation = sys.argv[3]
other = sys.argv[4]
services = document["services"]
if mutation == "api-token-only":
    del services["worker"]["environment"]["RUNNER_TOKEN"]
    services["api"]["environment"]["RUNNER_TOKEN"] = services["browser-runner"]["environment"]["RUNNER_TOKEN"]
elif mutation == "worker-missing":
    del services["worker"]["environment"]["RUNNER_TOKEN"]
elif mutation == "runner-mismatch":
    services["browser-runner"]["environment"]["RUNNER_TOKEN"] = other
elif mutation == "api-also-token":
    services["api"]["environment"]["RUNNER_TOKEN"] = services["worker"]["environment"]["RUNNER_TOKEN"]
elif mutation == "project-wrong":
    document["name"] = "other-project"
elif mutation == "postgres-volume-name-wrong":
    document["volumes"]["postgres-data"]["name"] = "agent-tasks_legacy-postgres-data"
else:
    raise SystemExit(f"unknown mutation: {mutation}")
with open(sys.argv[2], "w", encoding="utf-8") as handle:
    json.dump(document, handle)
PY
}

edit_fixture "$tmp/config-valid.json" "$tmp/config-api-token-only.json" api-token-only "$runner_other"
edit_fixture "$tmp/config-valid.json" "$tmp/config-worker-missing.json" worker-missing "$runner_other"
edit_fixture "$tmp/config-valid.json" "$tmp/config-runner-mismatch.json" runner-mismatch "$runner_other"
edit_fixture "$tmp/config-valid.json" "$tmp/config-api-also-token.json" api-also-token "$runner_other"
edit_fixture "$tmp/config-valid.json" "$tmp/config-project-wrong.json" project-wrong "$runner_other"
edit_fixture "$tmp/config-valid.json" "$tmp/config-volume-wrong.json" postgres-volume-name-wrong "$runner_other"

# A fixture that drifts from the real services must fail the contract check.
for drift in api-token-only worker-missing api-also-token; do
  if node "$repo/scripts/check-deploy-compose-contract.mjs" \
    --fixture "$tmp/config-$drift.json" > "$out" 2>&1; then
    fail "contract check accepted fixture drift '$drift'"
  fi
done

sed 's|https://tasks.internal.test|https://|' "$tmp/config-valid.json" > "$tmp/config-hostless.json"
sed 's|https://tasks.internal.test|http://tasks.internal.test|' "$tmp/config-valid.json" > "$tmp/config-http.json"
sed 's|https://tasks.internal.test|https://tasks.internal.test:notaport|' "$tmp/config-valid.json" > "$tmp/config-malformed.json"
sed "s|$valid_auth|replace-with-64-hex-characters|" "$tmp/config-valid.json" > "$tmp/config-placeholder.json"
# The fixture contract must reject a renamed top-level Docker volume, even when
# the service still mounts the same logical Compose key.
if node "$repo/scripts/check-deploy-compose-contract.mjs" \
  --fixture "$tmp/config-volume-wrong.json" > "$out" 2>&1; then
  fail 'contract check accepted a fixture with a different Postgres volume'
fi

add_search() {
  python3 - "$1" "$2" > "$3" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    document = json.load(source)
document["services"]["searxng"] = {
    "volumes": [
        {
            "type": "bind",
            "source": sys.argv[2],
            "target": "/etc/searxng/settings.yml",
            "read_only": True,
        }
    ]
}
json.dump(document, sys.stdout)
PY
}

add_search "$tmp/config-valid.json" "$remote/docker/searxng/settings.yml" "$tmp/config-search-valid.json"
add_search "$tmp/config-valid.json" "$tmp/missing-settings.yml" "$tmp/config-search-missing.json"
printf 'server:\n  secret_key: change-me-in-production\n' > "$tmp/placeholder-settings.yml"
add_search "$tmp/config-valid.json" "$tmp/placeholder-settings.yml" "$tmp/config-search-placeholder.json"

add_mail() {
  python3 - "$1" > "$2" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    document = json.load(source)
document["services"]["mailpit"] = {
    "profiles": ["mail"],
    "ports": [
        {
            "mode": "ingress",
            "target": 1025,
            "published": "1025",
            "protocol": "tcp",
            "host_ip": ""
        }
    ]
}
json.dump(document, sys.stdout)
PY
}

add_mail "$tmp/config-valid.json" "$tmp/config-mail-profile.json"

printf '172.18.0.0/16 172.18.0.1\n' > "$tmp/net-valid"
printf '172.19.0.0/16 172.19.0.1\n' > "$tmp/net-wrong"
printf '0.0.0.0/0 172.18.0.1\n' > "$tmp/net-wide"

preflight_case() {
  case_name=$1
  expected=$2
  config=$3
  network=$4
  env_mode=$5
  pattern=${6:-}
  : > "$calls"
  if env \
    PATH="$stub_bin:$PATH" \
    REMOTE_DIR="$remote" \
    DEPLOY_TEST_LOG="$calls" \
    DEPLOY_TEST_COMPOSE_JSON="$config" \
    DEPLOY_TEST_NETWORK_FILE="$network" \
    DEPLOY_TEST_ENV_MODE="$env_mode" \
    DEPLOY_TEST_SEARXNG_MODE="root:root 600" \
    sh "$tmp/preflight.sh" > "$out" 2>&1; then
    status=0
  else
    status=$?
  fi
  if grep -Fq -- "$postgres_value" "$out" ||
    grep -Fq -- "$auth_value" "$out" ||
    grep -Fq -- "$admin_value" "$out" ||
    grep -Fq -- "$runner_value" "$out" ||
    grep -Fq -- "$encryption_value" "$out"; then
    fail "preflight '$case_name' printed a secret value"
  fi
  case "$expected" in
    pass)
      [ "$status" -eq 0 ] || fail "preflight '$case_name' unexpectedly failed"
      ;;
    fail)
      [ "$status" -ne 0 ] || fail "preflight '$case_name' unexpectedly passed"
      if [ -n "$pattern" ]; then
        grep -Fq -- "$pattern" "$out" || fail "preflight '$case_name' did not mention '$pattern'"
      fi
      ;;
  esac
}

# The current-valid effective values and the exact webnet layout pass.
preflight_case valid pass "$tmp/config-valid.json" "$tmp/net-valid" 'root:root 600'
grep -q 'docker compose -p agent-tasks' "$calls" ||
  fail 'preflight did not pin the Compose project'
grep -q -- '-f .*compose.yaml.next config --format json' "$calls" ||
  fail 'preflight did not validate the candidate compose file explicitly'
# Raw .env is deliberately valid here; the effective rendered value is not.
preflight_case placeholder fail "$tmp/config-placeholder.json" "$tmp/net-valid" 'root:root 600' 'AUTH_SECRET'
preflight_case env-mode fail "$tmp/config-valid.json" "$tmp/net-valid" 'root:root 644' 'root:root 0600'
preflight_case hostless-url fail "$tmp/config-hostless.json" "$tmp/net-valid" 'root:root 600' 'PUBLIC_BASE_URL'
preflight_case non-https-url fail "$tmp/config-http.json" "$tmp/net-valid" 'root:root 600' 'https://'
preflight_case malformed-url fail "$tmp/config-malformed.json" "$tmp/net-valid" 'root:root 600' 'not a valid URL'
preflight_case wide-subnet fail "$tmp/config-valid.json" "$tmp/net-wide" 'root:root 600' '0.0.0.0/0'
preflight_case wrong-subnet fail "$tmp/config-valid.json" "$tmp/net-wrong" 'root:root 600' '172.18.0.0/16'
preflight_case search-valid pass "$tmp/config-search-valid.json" "$tmp/net-valid" 'root:root 600'
preflight_case search-missing fail "$tmp/config-search-missing.json" "$tmp/net-valid" 'root:root 600' 'missing'
preflight_case search-placeholder fail "$tmp/config-search-placeholder.json" "$tmp/net-valid" 'root:root 600' 'placeholder'
# The rendered Postgres mount must point at the existing named volume. A
# coordinated project/volume rename would otherwise make `up` create an empty
# volume and silently start a fresh database.
preflight_case postgres-volume fail "$tmp/config-volume-wrong.json" "$tmp/net-valid" 'root:root 600' 'agent-tasks_postgres-data'
# The optional mail profile publishes Mailpit on all host interfaces; production
# uses SMTP_URL with an external relay instead, so an active mail profile fails
# closed before any container changes.
preflight_case mail-profile fail "$tmp/config-mail-profile.json" "$tmp/net-valid" 'root:root 600' 'mail profile'
# The runner token is validated on the services that actually use it.
preflight_case runner-token-api fail "$tmp/config-api-token-only.json" "$tmp/net-valid" 'root:root 600' 'RUNNER_TOKEN'
preflight_case runner-token-missing fail "$tmp/config-worker-missing.json" "$tmp/net-valid" 'root:root 600' 'RUNNER_TOKEN'
preflight_case runner-token-mismatch fail "$tmp/config-runner-mismatch.json" "$tmp/net-valid" 'root:root 600' 'identical on worker and browser-runner'
preflight_case runner-token-on-api fail "$tmp/config-api-also-token.json" "$tmp/net-valid" 'root:root 600' 'never on api'
preflight_case project-name fail "$tmp/config-project-wrong.json" "$tmp/net-valid" 'root:root 600' 'agent-tasks'

# A stubbed real run proves the staging/promotion/up sequence while all SSH/rsync
# calls stay local. The first run has no staged profile, so the runner is recreated.
: > "$calls"
: > "$stdin_log"
if ! run_deploy "root@deploy.invalid" env DEPLOY_TEST_SECCOMP_STATE=missing "$deploy" > "$out" 2>&1; then
  fail 'stubbed real run failed'
fi
grep -q '^ssh ' "$calls" || fail 'stubbed run did not use ssh'
grep -q 'rsync .*compose.production.yaml.*:.*/compose.yaml.next' "$calls" ||
  fail 'stubbed run did not stage the production compose file'
grep -q 'rsync .*seccomp-browser.json.*:.*/docker/seccomp-browser.json.next' "$calls" ||
  fail 'stubbed run did not stage the seccomp profile'
grep -q 'docker network inspect webnet' "$stdin_log" ||
  fail 'stubbed run did not send the webnet preflight'
grep -q 'pg_dump' "$stdin_log" || fail 'stubbed run did not send the database backup'
grep -q 'docker compose -p agent-tasks' "$calls" ||
  fail 'stubbed run did not pin the Compose project'
grep -q 'up -d --no-deps --force-recreate --wait --wait-timeout 180 browser-runner' "$calls" ||
  fail 'missing seccomp profile did not force-recreate browser-runner'
grep -q 'browser-runner$' "$calls" || fail 'force-recreate did not target only browser-runner'
grep -q 'up -d --wait --wait-timeout 180$' "$calls" || fail 'stubbed run did not reconcile the stack'
[ -d "$test_home/.ssh/agent-tasks-deploy" ] || fail 'stubbed run did not create a private control directory'
mode=$(file_mode "$test_home/.ssh/agent-tasks-deploy")
[ "$mode" = "700" ] || fail "control directory mode is $mode, expected 700"

# The walkthrough executes prerequisites, preflight, secret/DB backup and
# promotion in this order; the runner recreate and general up follow.
previous=0
for marker in prereq assets seccomp preflight backup promote validation; do
  position=$(line_of "ssh-body $marker" "$calls")
  [ -n "$position" ] || fail "stubbed run did not execute the $marker step"
  [ "$position" -gt "$previous" ] || fail "stubbed run executed $marker out of order"
  previous=$position
done
up_position=$(grep -n 'up -d --wait --wait-timeout 180$' "$calls" | head -n 1 | cut -d: -f1)
[ -n "$up_position" ] || fail 'stubbed run did not record the final up'
[ "$previous" -lt "$up_position" ] || fail 'the final up ran before validation'

secret_position=$(line_of 'cp -p .env' "$stdin_log")
dump_position=$(line_of 'pg_dump' "$stdin_log")
promote_position=$(line_of 'mv -f compose.yaml.next compose.yaml' "$stdin_log")
[ -n "$secret_position" ] || fail 'backup body does not copy .env'
[ -n "$dump_position" ] || fail 'backup body does not dump postgres'
[ -n "$promote_position" ] || fail 'promote body does not activate compose.yaml'
[ "$secret_position" -lt "$dump_position" ] ||
  fail 'the .env backup does not precede the database dump'
[ "$dump_position" -lt "$promote_position" ] ||
  fail 'the database dump does not precede the compose promotion'

# No Compose invocation may rely on the host .env or an ambient project name.
if grep -h 'docker compose' "$calls" "$stdin_log" | grep -v -- '-p agent-tasks' | grep -q .; then
  fail 'a Compose invocation is missing -p agent-tasks'
fi
if grep -h 'docker compose' "$calls" "$stdin_log" | grep -v -- ' -f ' | grep -q .; then
  fail 'a Compose invocation is missing an explicit -f file'
fi

local_hash=$(file_hash "$repo/docker/seccomp-browser.json") ||
  fail 'sha256sum or shasum is required to compare the seccomp profile'

# Unchanged staged bytes must not force-recreate anything.
: > "$calls"
: > "$stdin_log"
if ! run_deploy "root@deploy.invalid" env DEPLOY_TEST_SECCOMP_STATE="$local_hash" "$deploy" > "$out" 2>&1; then
  fail 'stubbed unchanged-seccomp run failed'
fi
if grep -q 'force-recreate' "$calls"; then
  fail 'unchanged seccomp profile still force-recreated a service'
fi

# Changed staged bytes must recreate exactly browser-runner, with no deps.
: > "$calls"
: > "$stdin_log"
if ! run_deploy "root@deploy.invalid" env DEPLOY_TEST_SECCOMP_STATE=deadbeef "$deploy" > "$out" 2>&1; then
  fail 'stubbed changed-seccomp run failed'
fi
grep -q 'up -d --no-deps --force-recreate --wait --wait-timeout 180 browser-runner' "$calls" ||
  fail 'changed seccomp profile did not recreate only browser-runner'

# A symlinked host profile must fail closed before rsync could follow it.
: > "$calls"
: > "$stdin_log"
if run_deploy "root@deploy.invalid" env DEPLOY_TEST_SECCOMP_STATE=symlink "$deploy" > "$out" 2>&1; then
  fail 'symlinked seccomp profile was accepted'
fi
grep -q 'must not be a symlink' "$out" || fail 'symlinked seccomp profile error is unclear'
if grep -q '^rsync ' "$calls"; then
  fail 'symlinked seccomp profile was still staged with rsync'
fi

# Invalid local JSON must fail closed before any transfer, even in a dry run.
copy="$tmp/deploy-copy"
mkdir -p "$copy/deployment" "$copy/docker"
cp "$repo/deployment/deploy.sh" "$copy/deployment/"
cp "$repo/deployment/compose.production.yaml" "$copy/deployment/"
cp "$repo/docker/seccomp-browser.json" "$copy/docker/"
printf '{not valid json' > "$copy/docker/seccomp-browser.json"
: > "$calls"
: > "$stdin_log"
if run_deploy "root@deploy.invalid" "$copy/deployment/deploy.sh" --dry-run > "$out" 2>&1; then
  fail 'invalid local seccomp JSON was accepted'
fi
grep -q 'not a valid JSON object' "$out" || fail 'invalid seccomp JSON error is unclear'
[ ! -s "$calls" ] || fail 'invalid seccomp JSON still invoked ssh/rsync'

# Execute the extracted backup body: a running postgres produces a valid dump and
# a root-only .env copy, in that order relative to promotion (checked above).
backup_ok="$tmp/backup-running"
prepare_remote_dir "$backup_ok"
printf 'CREATE TABLE example (id integer);\n' > "$tmp/pgdump.sql"
: > "$calls"
if ! env \
  PATH="$stub_bin:$PATH" \
  REMOTE_DIR="$backup_ok" \
  DB_BACKUP_CONFIRM= \
  DEPLOY_TEST_LOG="$calls" \
  DEPLOY_TEST_POSTGRES_CONTAINER=test-container \
  DEPLOY_TEST_POSTGRES_RUNNING=true \
  DEPLOY_TEST_PGDUMP="$tmp/pgdump.sql" \
  DEPLOY_TEST_VOLUME_STATUS=1 \
  sh "$tmp/backup.sh" > "$out" 2>&1; then
  fail 'backup script failed for a running postgres'
fi
dump=$(find "$backup_ok/backups" -type f -name postgres.sql.gz | head -n 1)
[ -n "$dump" ] || fail 'backup script did not write postgres.sql.gz'
gzip -t "$dump" || fail 'backup script wrote an invalid gzip archive'
gunzip -c "$dump" > "$tmp/restored.sql"
cmp -s "$tmp/restored.sql" "$tmp/pgdump.sql" || fail 'backup archive does not contain the dump'
backup_env=$(dirname "$dump")/env
[ -f "$backup_env" ] || fail 'backup script did not copy .env'
cmp -s "$backup_env" "$backup_ok/.env" || fail 'backup .env copy differs from the host .env'
[ "$(file_mode "$backup_env")" = "600" ] || fail 'backup .env copy is not mode 600'
grep -q 'docker compose -p agent-tasks' "$calls" ||
  fail 'backup script did not pin the Compose project'
grep -q ' exec -T postgres ' "$calls" || fail 'backup script did not exec into postgres'

# An empty pg_dump must stop the deploy before promotion.
backup_empty="$tmp/backup-empty"
prepare_remote_dir "$backup_empty"
: > "$tmp/pgdump-empty.sql"
: > "$calls"
if env \
  PATH="$stub_bin:$PATH" \
  REMOTE_DIR="$backup_empty" \
  DB_BACKUP_CONFIRM= \
  DEPLOY_TEST_LOG="$calls" \
  DEPLOY_TEST_POSTGRES_CONTAINER=test-container \
  DEPLOY_TEST_POSTGRES_RUNNING=true \
  DEPLOY_TEST_PGDUMP="$tmp/pgdump-empty.sql" \
  DEPLOY_TEST_VOLUME_STATUS=1 \
  sh "$tmp/backup.sh" > "$out" 2>&1; then
  fail 'backup script accepted an empty pg_dump'
fi
grep -q 'empty file' "$out" || fail 'empty pg_dump error is unclear'
if find "$backup_empty/backups" -type f -name '*.gz' | grep -q .; then
  fail 'empty pg_dump still wrote a gzip archive'
fi

# A stopped postgres with an existing volume must fail without an explicit
# confirmation, and continue only when the operator confirms a prior dump.
backup_stopped="$tmp/backup-stopped"
prepare_remote_dir "$backup_stopped"
: > "$calls"
if env \
  PATH="$stub_bin:$PATH" \
  REMOTE_DIR="$backup_stopped" \
  DB_BACKUP_CONFIRM= \
  DEPLOY_TEST_LOG="$calls" \
  DEPLOY_TEST_POSTGRES_CONTAINER= \
  DEPLOY_TEST_PGDUMP="$tmp/pgdump.sql" \
  DEPLOY_TEST_VOLUME_STATUS=0 \
  sh "$tmp/backup.sh" > "$out" 2>&1; then
  fail 'backup script accepted a stopped postgres without confirmation'
fi
grep -q 'DEPLOY_DB_BACKUP_CONFIRM=backed-up' "$out" ||
  fail 'stopped-postgres error does not name the confirmation'
if find "$backup_stopped/backups" -type f -name '*.gz' | grep -q .; then
  fail 'stopped postgres still produced a database archive'
fi

backup_confirmed="$tmp/backup-confirmed"
prepare_remote_dir "$backup_confirmed"
: > "$calls"
if ! env \
  PATH="$stub_bin:$PATH" \
  REMOTE_DIR="$backup_confirmed" \
  DB_BACKUP_CONFIRM=backed-up \
  DEPLOY_TEST_LOG="$calls" \
  DEPLOY_TEST_POSTGRES_CONTAINER= \
  DEPLOY_TEST_PGDUMP="$tmp/pgdump.sql" \
  DEPLOY_TEST_VOLUME_STATUS=0 \
  sh "$tmp/backup.sh" > "$out" 2>&1; then
  fail 'backup script rejected the explicit operator confirmation'
fi
grep -q 'operator-confirmed prior dump' "$out" || fail 'confirmed backup path is unclear'

# First deploy: no existing volume means no dump is expected.
backup_first="$tmp/backup-first"
prepare_remote_dir "$backup_first"
if ! env \
  PATH="$stub_bin:$PATH" \
  REMOTE_DIR="$backup_first" \
  DB_BACKUP_CONFIRM= \
  DEPLOY_TEST_LOG="$calls" \
  DEPLOY_TEST_POSTGRES_CONTAINER= \
  DEPLOY_TEST_PGDUMP="$tmp/pgdump.sql" \
  DEPLOY_TEST_VOLUME_STATUS=1 \
  sh "$tmp/backup.sh" > "$out" 2>&1; then
  fail 'backup script failed on the first deploy'
fi
grep -q 'first deploy' "$out" || fail 'first-deploy backup path is unclear'

# Execute the extracted promote body: staged files become active with 0644.
promote_dir="$tmp/promote-host"
mkdir -p "$promote_dir/docker"
printf 'AUTH_SECRET=test\n' > "$promote_dir/.env"
printf 'name: old\n' > "$promote_dir/compose.yaml"
printf '{"old":true}\n' > "$promote_dir/docker/seccomp-browser.json"
printf 'name: agent-tasks\n' > "$promote_dir/compose.yaml.next"
printf '{"defaultAction":"SCMP_ACT_ERRNO"}\n' > "$promote_dir/docker/seccomp-browser.json.next"
cp "$promote_dir/compose.yaml.next" "$tmp/expected-compose.yaml"
cp "$promote_dir/docker/seccomp-browser.json.next" "$tmp/expected-seccomp.json"
if ! env \
  PATH="$stub_bin:$PATH" \
  REMOTE_DIR="$promote_dir" \
  DEPLOY_TEST_LOG="$calls" \
  sh "$tmp/promote.sh" > "$out" 2>&1; then
  fail 'promote script failed'
fi
cmp -s "$promote_dir/compose.yaml" "$tmp/expected-compose.yaml" ||
  fail 'promote script did not activate the staged compose file'
cmp -s "$promote_dir/docker/seccomp-browser.json" "$tmp/expected-seccomp.json" ||
  fail 'promote script did not activate the staged seccomp profile'
[ ! -e "$promote_dir/compose.yaml.next" ] || fail 'promote left compose.yaml.next behind'
[ ! -e "$promote_dir/docker/seccomp-browser.json.next" ] ||
  fail 'promote left the staged seccomp profile behind'
[ "$(file_mode "$promote_dir/compose.yaml")" = "644" ] ||
  fail 'promoted compose.yaml is not mode 644'

# stack.sh production is config validation only: the first argument must be the
# `config` subcommand, and it must not create a local production.env or start,
# stop or pull the host stack. The docker stub keeps this check offline.
had_production_env=0
[ ! -e "$repo/deployment/env/production.env" ] || had_production_env=1
: > "$calls"
if ! PATH="$stub_bin:$PATH" DEPLOY_TEST_LOG="$calls" \
  sh "$repo/deployment/stack.sh" production config -q > "$out" 2>&1; then
  fail 'stack.sh production config failed'
fi
grep -q 'docker compose -p agent-tasks' "$calls" ||
  fail 'stack.sh production did not pin the Compose project'
for rejected in 'up -d' 'up config'; do
  # shellcheck disable=SC2086 # the argv split is the tested behaviour
  if PATH="$stub_bin:$PATH" DEPLOY_TEST_LOG="$calls" \
    sh "$repo/deployment/stack.sh" production $rejected > "$out" 2>&1; then
    fail "stack.sh production $rejected was not rejected"
  fi
  grep -q 'limited to local' "$out" || fail "stack.sh production $rejected error is unclear"
done
if [ "$had_production_env" -eq 0 ] && [ -e "$repo/deployment/env/production.env" ]; then
  fail 'stack.sh production created a local production.env'
fi

# Offline volume-source tests for the compose parity comparison.
if ! node "$repo/scripts/test-compose-parity.mjs" > "$out" 2>&1; then
  fail 'compose parity volume tests failed'
fi

printf 'deploy test: OK (offline dry run, strict SSH, executed prereq/preflight/backup/promote bodies, Compose project/file pinning, override and COMPOSE_* rejection, RUNNER_TOKEN on worker+browser-runner, local seccomp JSON validation, DB-backup success/failure paths, promotion, production stack.sh is config-only)\n'
