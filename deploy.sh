#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
CONFIG="$ROOT/.env.deploy"
LOCK="$ROOT/.deploy.lock"

fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ ! -L "$LOCK" ]] || fail "Refusing to use a symlink as the deployment lock file."
exec 9>>"$LOCK"
flock -n 9 || fail "Another deployment operation is active in this checkout; wait for it to finish and retry."
prompt() {
  local name="$1" label="$2" value=""
  read -r -p "$label: " value
  printf -v "$name" '%s' "$value"
}
prompt_secret() {
  local name="$1" label="$2" value=""
  read -r -s -p "$label (hidden; leave blank to disable): " value
  printf '\n'
  printf -v "$name" '%s' "$value"
}
valid_env_value() {
  [[ "$1" =~ ^[a-zA-Z0-9._~+/=-]*$ ]]
}
validate_url_contract() {
  node --input-type=module -e '
    import { isIP } from "node:net";
    const [mode, rawUrl, publicHost, appPort] = process.argv.slice(1);
    let url;
    try { url = new URL(rawUrl); } catch { process.exit(1); }
    if (url.origin !== rawUrl || url.username || url.password || url.pathname !== "/" || url.search || url.hash) process.exit(1);
    if (mode === "local") {
      const validPort = /^\d+$/u.test(appPort) && Number(appPort) >= 1 && Number(appPort) <= 65535;
      if (!validPort || url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.port !== appPort || publicHost) process.exit(1);
    } else if (mode === "public") {
      const labels = publicHost.split(".");
      const validDnsName = labels.length >= 2 && publicHost.length <= 253
        && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label));
      if (url.protocol !== "https:" || url.port || isIP(url.hostname) || !validDnsName || url.hostname !== publicHost || rawUrl !== `https://${publicHost}`) process.exit(1);
    } else process.exit(1);
  ' "$1" "$2" "$3" "$4"
}
write_config() {
  local mode="$1" public_url="$2" public_host="$3" app_port="$4"
  local secret="$5" github_id="$6" github_secret="$7" google_id="$8" google_secret="$9"
  for value in "$mode" "$public_host" "$app_port" "$secret" "$github_id" "$github_secret" "$google_id" "$google_secret" "$(id -u)" "$(id -g)"; do
    valid_env_value "$value" || fail "配置中包含不支持的字符。请使用不含空格、引号、美元符号或换行的值。"
  done
  validate_url_contract "$mode" "$public_url" "$public_host" "$app_port" || fail "PUBLIC_URL 无效：本地模式只允许 loopback HTTP；公网模式只允许标准 HTTPS DNS 域名且不得包含端口、凭据或路径。"
  {
    printf 'DEPLOYMENT_MODE=%s\n' "$mode"
    printf 'PUBLIC_URL=%s\n' "$public_url"
    printf 'PUBLIC_HOST=%s\n' "$public_host"
    printf 'APP_PORT=%s\n' "$app_port"
    printf 'PUBLIC_HTTP_PORT=80\nPUBLIC_HTTPS_PORT=443\n'
    printf 'DATA_DIR=./.local-data/deploy\nAPP_UID=%s\nAPP_GID=%s\n' "$(id -u)" "$(id -g)"
    printf 'BETTER_AUTH_SECRET=%s\n' "$secret"
    printf 'GITHUB_CLIENT_ID=%s\nGITHUB_CLIENT_SECRET=%s\n' "$github_id" "$github_secret"
    printf 'GOOGLE_CLIENT_ID=%s\nGOOGLE_CLIENT_SECRET=%s\n' "$google_id" "$google_secret"
    printf 'FRONTEND_ATLAS_ALLOW_DB_INITIALIZE=0\n'
  } > "$CONFIG"
  chmod 600 "$CONFIG"
}
read_mode_from_config() {
  sed -n 's/^DEPLOYMENT_MODE=//p' "$CONFIG" | head -n 1
}
compose() {
  local mode
  mode="$(read_mode_from_config)"
  local -a args=(docker compose --env-file "$CONFIG")
  if [[ "$mode" == "public" ]]; then args+=(--profile public -f compose.yaml); else args+=(-f compose.yaml -f compose.local.yaml); fi
  "${args[@]}" "$@"
}
setup() {
  [[ ! -e "$CONFIG" ]] || fail ".env.deploy already exists; it was left untouched. Edit it manually or back it up before replacing it."
  [[ "$(id -u)" != "0" ]] || fail "Run this helper as the unprivileged deployment operator; the app container must not run as root."
  local mode public_url public_host app_port secret github_id github_secret google_id google_secret
  read -r -p "Deployment mode [local/public] (local): " mode
  mode="${mode:-local}"
  if [[ "$mode" == "public" ]]; then
    prompt public_host "Public DNS hostname (without scheme, path, or port)"
    public_host="${public_host,,}"
    public_url="https://$public_host"
    app_port=""
  elif [[ "$mode" == "local" ]]; then
    read -r -p "Local browser port (3010): " app_port
    app_port="${app_port:-3010}"
    public_url="http://127.0.0.1:$app_port"
    public_host=""
  else
    fail "Mode must be local or public."
  fi
  prompt_secret secret "Better Auth secret (minimum 32 characters)"
  ((${#secret} >= 32 && ${#secret} <= 256)) || fail "Better Auth secret must contain 32 to 256 characters."
  prompt github_id "GitHub OAuth client ID"
  prompt_secret github_secret "GitHub OAuth client secret"
  prompt google_id "Google OAuth client ID"
  prompt_secret google_secret "Google OAuth client secret"
  if [[ -n "$github_id" && -z "$github_secret" || -z "$github_id" && -n "$github_secret" ]]; then fail "GitHub OAuth ID and secret must be supplied together."; fi
  if [[ -n "$google_id" && -z "$google_secret" || -z "$google_id" && -n "$google_secret" ]]; then fail "Google OAuth ID and secret must be supplied together."; fi
  write_config "$mode" "$public_url" "$public_host" "$app_port" "$secret" "$github_id" "$github_secret" "$google_id" "$google_secret"
  printf 'Created private .env.deploy. Secrets were not displayed.\n'
}
validate_and_build() {
  command -v docker >/dev/null || fail "Docker is required."
  docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin is required."
  compose config --quiet
  compose build app
  compose run --rm --no-deps app node scripts/validate-deployment-config.mjs
}
ensure_operator_storage() {
  local operator_uid operator_gid config_uid config_gid directory owner_uid owner_gid
  operator_uid="$(id -u)"
  operator_gid="$(id -g)"
  [[ "$operator_uid" != "0" ]] || fail "Run this helper as the unprivileged deployment operator; the app container must not run as root."
  config_uid="$(sed -n 's/^APP_UID=//p' "$CONFIG" | head -n 1)"
  config_gid="$(sed -n 's/^APP_GID=//p' "$CONFIG" | head -n 1)"
  [[ "$config_uid" == "$operator_uid" && "$config_gid" == "$operator_gid" ]] || fail "APP_UID/APP_GID must match this unprivileged operator ($operator_uid:$operator_gid); no data or ownership changes were made."
  [[ ! -L "$ROOT/.local-data" ]] || fail "Refusing to use a symlink as the deployment data root."
  mkdir -p -- "$ROOT/.local-data"
  for directory in "$ROOT/.local-data/deploy" "$ROOT/.local-data/backups"; do
    [[ ! -L "$directory" ]] || fail "Refusing to use a symlink as a deployment data directory: $directory"
    mkdir -p -- "$directory"
    owner_uid="$(stat -c '%u' -- "$directory")"
    owner_gid="$(stat -c '%g' -- "$directory")"
    [[ "$owner_uid" == "$operator_uid" && "$owner_gid" == "$operator_gid" ]] || fail "Data directory $directory belongs to UID:GID $owner_uid:$owner_gid, not $operator_uid:$operator_gid. It was not changed; inspect or move it manually before retrying."
  done
}
assert_app_stopped() {
  local container state
  container="$(compose ps -a -q app)"
  [[ -z "$container" ]] && return 0
  state="$(docker inspect --format '{{.State.Status}}' "$container")"
  [[ "$state" == "exited" || "$state" == "dead" ]] || fail "App container state is '$state'. Stop the stack with ./deploy.sh down before restoring."
}
up() {
  [[ -f "$CONFIG" ]] || setup
  ensure_operator_storage
  validate_and_build
  if [[ ! -f "$ROOT/.local-data/deploy/coach.sqlite" ]]; then
    read -r -p "No deployment database exists. Initialize a new empty SQLite database? [y/N] " answer
    [[ "$answer" == "y" || "$answer" == "Y" ]] || fail "Database initialization was not approved; no empty database was created."
    compose run --rm --no-deps -e FRONTEND_ATLAS_ALLOW_DB_INITIALIZE=1 app npm run db:migrate:runtime
  fi
  compose up -d
  printf 'Deployment started. Use ./deploy.sh status or ./deploy.sh logs.\n'
  printf 'Public URL: %s\n' "$(sed -n 's/^PUBLIC_URL=//p' "$CONFIG" | head -n 1)"
}
case "${1:-up}" in
  init) setup ;;
  up) up ;;
  status) [[ -f "$CONFIG" ]] || fail "Run ./deploy.sh init first."; compose ps ;;
  logs) [[ -f "$CONFIG" ]] || fail "Run ./deploy.sh init first."; compose logs --tail=100 -f ;;
  down) [[ -f "$CONFIG" ]] || fail "Run ./deploy.sh init first."; compose down ;;
  backup)
    [[ -f "$CONFIG" ]] || fail "Run ./deploy.sh init first."
    name="${2:-}"
    [[ "$name" =~ ^[a-zA-Z0-9._-]+\.sqlite$ ]] || fail "Usage: ./deploy.sh backup NAME.sqlite"
    [[ ! -e "$ROOT/.local-data/backups/$name" ]] || fail "The host backup destination already exists; choose a new filename."
    compose exec -T app node scripts/backup-sqlite.mjs "/data/backups/$name"
    mkdir -p "$ROOT/.local-data/backups"
    container="$(compose ps -q app)"
    [[ -n "$container" ]] || fail "The app container is not running."
    docker cp "$container:/data/backups/$name" "$ROOT/.local-data/backups/$name" >/dev/null
    printf 'Backup copied to .local-data/backups/%s\n' "$name"
    ;;
  restore)
    [[ -f "$CONFIG" ]] || fail "Run ./deploy.sh init first."
    source_file="${2:-}"
    target="${3:-}"
    [[ -f "$source_file" && "$target" == "/data/coach.sqlite" ]] || fail "Usage: ./deploy.sh restore BACKUP.sqlite /data/coach.sqlite (stop the stack first)"
    assert_app_stopped
    mkdir -p "$ROOT/.local-data/deploy/backups"
    name="$(basename -- "$source_file")"
    [[ ! -e "$ROOT/.local-data/deploy/backups/$name" ]] || fail "A copy with this name already exists in the deployment data directory; rename the source backup first."
    printf 'WARNING: this replaces %s with %s. A pre-restore recovery copy is retained.\n' "$target" "$source_file"
    read -r -p "Type RESTORE to confirm the exact target: " answer
    [[ "$answer" == "RESTORE" ]] || fail "Restore canceled."
    assert_app_stopped
    cp -- "$source_file" "$ROOT/.local-data/deploy/backups/$name"
    compose run --rm --no-deps app node scripts/restore-sqlite.mjs \
      "--source=/data/backups/$name" --target="$target" --confirm-target="$target" --replace-existing
    ;;
  *) fail "Usage: ./deploy.sh [init|up|status|logs|down|backup NAME.sqlite|restore BACKUP.sqlite /data/coach.sqlite]" ;;
esac
