#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ ! -e .env.deploy ]] || { printf '%s\n' "Refusing to overwrite an existing .env.deploy." >&2; exit 2; }
command -v docker >/dev/null || { printf '%s\n' "NOT_RUN: Docker CLI is unavailable."; exit 0; }
docker info >/dev/null 2>&1 || { printf '%s\n' "NOT_RUN: Docker daemon is unavailable to this task."; exit 0; }
docker info --format 'Docker daemon architecture: {{.Architecture}}'

project="atlas-deploy-test-$$"
app_port=38731
data_dir="$(mktemp -d /tmp/atlas-deploy-data.XXXXXX)"
override="$(mktemp /tmp/atlas-deploy-compose.XXXXXX.yaml)"
public_env="$(mktemp /tmp/atlas-deploy-public-env.XXXXXX)"
cleanup() {
  docker compose --project-name "$project" --env-file .env.deploy -f compose.yaml -f compose.local.yaml -f "$override" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -f .env.deploy "$override" "$public_env"
  rm -rf "$data_dir"
}
trap cleanup EXIT
cat > .env.deploy <<EOF
DEPLOYMENT_MODE=local
PUBLIC_URL=http://127.0.0.1:$app_port
PUBLIC_HOST=
APP_PORT=$app_port
PUBLIC_HTTP_PORT=38080
PUBLIC_HTTPS_PORT=38443
APP_UID=$(id -u)
APP_GID=$(id -g)
BETTER_AUTH_SECRET=deployment-integration-test-secret-000000000000
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
FRONTEND_ATLAS_ALLOW_DB_INITIALIZE=0
EOF
chmod 600 .env.deploy
cat > "$public_env" <<EOF
DEPLOYMENT_MODE=public
PUBLIC_URL=https://deploy-test.example.org
PUBLIC_HOST=deploy-test.example.org
APP_PORT=
PUBLIC_HTTP_PORT=38080
PUBLIC_HTTPS_PORT=38443
APP_UID=$(id -u)
APP_GID=$(id -g)
BETTER_AUTH_SECRET=deployment-test-secret-that-is-at-least-32-chars
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
FRONTEND_ATLAS_ALLOW_DB_INITIALIZE=0
EOF
chmod 600 "$public_env"
cat > "$override" <<EOF
services:
  app:
    volumes:
      - type: bind
        source: $data_dir
        target: /data
EOF

compose=(docker compose --project-name "$project" --env-file .env.deploy -f compose.yaml -f compose.local.yaml -f "$override")
"${compose[@]}" config --quiet
docker compose --project-name "$project-public" --env-file "$public_env" --profile public -f compose.yaml config --quiet
npm run test:deployment-config
npm run test:deployment-db
printf 'Building production image…\n'
"${compose[@]}" build app
docker run --rm -e PUBLIC_HOST=deploy-test.example.org -v "$ROOT/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.11.7-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
"${compose[@]}" run --rm --no-deps -e FRONTEND_ATLAS_ALLOW_DB_INITIALIZE=1 app npm run db:migrate:runtime >/dev/null
"${compose[@]}" up -d app >/dev/null

healthy=0
for attempt in $(seq 1 60); do
  if node -e "fetch('http://127.0.0.1:$app_port/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then healthy=1; break; fi
  sleep 2
done
[[ "$healthy" == 1 ]] || { "${compose[@]}" logs --no-color app >/dev/null; printf '%s\n' "Container did not become healthy." >&2; exit 1; }

container="$("${compose[@]}" ps -q app)"
mount_source="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$container")"
[[ "$mount_source" == "$data_dir" ]] || { printf '%s\n' "Test container did not use the isolated temporary data mount." >&2; exit 1; }
image="$(docker inspect -f '{{.Config.Image}}' "$container")"
image_user="$(docker image inspect -f '{{.Config.User}}' "$image")"
container_user="$(docker inspect -f '{{.Config.User}}' "$container")"
image_ports="$(docker image inspect -f '{{json .Config.ExposedPorts}}' "$image")"
[[ "$image_user" == "node" ]] || { printf 'Image is not configured for its non-root node user: %s\n' "$image_user" >&2; exit 1; }
[[ "$container_user" == "$(id -u):$(id -g)" && "$(id -u)" != "0" ]] || { printf 'Unexpected container user: %s\n' "$container_user" >&2; exit 1; }
[[ "$image_ports" != *4317* ]] || { printf '%s\n' "Internal SIWC port was exposed by the image." >&2; exit 1; }
docker exec "$container" test ! -e /app/server/index.mjs
docker exec "$container" sh -c '! command -v git >/dev/null'

node --input-type=module - <<EOF
const root = 'http://127.0.0.1:$app_port';
const healthy = await fetch(root + '/api/health');
if (!healthy.ok) throw new Error('health route failed');
const visible = await fetch(root + '/coach/');
if (visible.status !== 404) throw new Error('local-only coach page was not disabled');
const good = await fetch(root + '/api/auth/get-session', { headers: { origin: root } });
if (good.status >= 500) throw new Error('runtime auth URL did not initialize');
const bad = await fetch(root + '/api/auth/sign-in/social', {
  method: 'POST',
  headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
  body: JSON.stringify({ provider: 'github', callbackURL: '/' }),
});
if (bad.status < 400) throw new Error('unexpected Origin was accepted');
EOF

docker exec "$container" node -e "const D=require('better-sqlite3');const d=new D('/data/coach.sqlite');d.exec('CREATE TABLE IF NOT EXISTS deploy_restart_probe(value TEXT NOT NULL);DELETE FROM deploy_restart_probe;INSERT INTO deploy_restart_probe VALUES (\"preserved\")');d.close()"
"${compose[@]}" restart app >/dev/null
for attempt in $(seq 1 45); do
  if node -e "fetch('http://127.0.0.1:$app_port/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then break; fi
  sleep 2
done
docker exec "$("${compose[@]}" ps -q app)" node -e "const D=require('better-sqlite3');const d=new D('/data/coach.sqlite',{readonly:true});if(d.prepare('SELECT value FROM deploy_restart_probe').get().value!=='preserved')process.exit(1);d.close()"

printf '%s\n' "PASS: Compose validation, pinned image build, Caddy config, explicit DB init/migrations, health, exact Origin rejection, runtime auth URL, disabled local AI page, non-root image, no Git/SIWC service, unexposed 4317, and restart persistence."
