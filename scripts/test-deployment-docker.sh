#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ ! -e .env.deploy ]] || { printf '%s\n' "Refusing to overwrite an existing .env.deploy." >&2; exit 2; }
require_docker="${FRONTEND_ATLAS_REQUIRE_DOCKER:-0}"
command -v docker >/dev/null || { [[ "$require_docker" != 1 ]] && { printf '%s\n' "NOT_RUN: Docker CLI is unavailable."; exit 0; }; printf '%s\n' "Docker CLI is required in this CI job." >&2; exit 1; }
docker info >/dev/null 2>&1 || { [[ "$require_docker" != 1 ]] && { printf '%s\n' "NOT_RUN: Docker daemon is unavailable to this task."; exit 0; }; printf '%s\n' "Docker daemon is required in this CI job." >&2; exit 1; }
docker info --format 'Docker daemon architecture: {{.Architecture}}'

project="atlas-deploy-test-$$"
app_port="$(node -e 'const server=require("node:net").createServer();server.listen(0,"127.0.0.1",()=>{console.log(server.address().port);server.close()})')"
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
GITHUB_CLIENT_ID=deployment-test-client-id
GITHUB_CLIENT_SECRET=deployment-test-client-secret
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
npm run test:deploy-init
printf 'Building production image…\n'
"${compose[@]}" build app
docker run --rm -e PUBLIC_HOST=deploy-test.example.org -v "$ROOT/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.11.7-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
"${compose[@]}" run --rm --no-deps -e FRONTEND_ATLAS_ALLOW_DB_INITIALIZE=1 app npm run db:migrate:runtime >/dev/null
[[ -f "$data_dir/coach.sqlite" ]] || { printf '%s\n' "Explicit initialization did not create the isolated test database." >&2; exit 1; }
"${compose[@]}" run --rm --no-deps app npm run db:migrate:runtime >/dev/null
"${compose[@]}" up -d app >/dev/null

healthy=0
for attempt in $(seq 1 60); do
  if node -e "fetch('http://127.0.0.1:$app_port/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then healthy=1; break; fi
  sleep 2
done
[[ "$healthy" == 1 ]] || { "${compose[@]}" logs --no-color app >/dev/null; printf '%s\n' "Container did not become healthy." >&2; exit 1; }
container="$("${compose[@]}" ps -q app)"
health_state="$(docker inspect -f '{{.State.Health.Status}}' "$container")"
[[ "$health_state" == healthy ]] || { printf 'Container healthcheck did not reach healthy state: %s\n' "$health_state" >&2; exit 1; }

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
docker exec "$container" node -e "const fs=require('node:fs'),p='/app/.next/cache/.deployment-cache-probe';fs.writeFileSync(p,'ok');fs.unlinkSync(p)"
docker exec "$container" node -e "const fs=require('node:fs');try{fs.writeFileSync('/app/.readonly-probe','x');process.exit(1)}catch(error){if(error.code!=='EROFS')process.exit(2)}"

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

FRONTEND_ATLAS_TEST_URL="http://127.0.0.1:$app_port" CHROMIUM_PATH="${CHROMIUM_PATH:-}" node scripts/test-deployment-browser.mjs

docker exec "$container" node -e "const D=require('better-sqlite3'),fs=require('node:fs');const p='/data/coach.sqlite',d=new D(p);if(d.pragma('journal_mode',{simple:true})!=='wal')process.exit(2);d.exec('CREATE TABLE IF NOT EXISTS deploy_restart_probe(value TEXT NOT NULL)');const write=d.transaction(()=>d.prepare('INSERT OR REPLACE INTO deploy_restart_probe(rowid,value) VALUES (1,?)').run('preserved'));write();if(!fs.existsSync(p+'-wal'))process.exit(3);d.close()"
docker exec "$container" node scripts/backup-sqlite.mjs /data/backups/docker-snapshot.sqlite
docker exec "$container" node -e "const D=require('better-sqlite3'),d=new D('/data/coach.sqlite');d.prepare('UPDATE deploy_restart_probe SET value=? WHERE rowid=1').run('changed-after-backup');d.close()"
"${compose[@]}" stop app >/dev/null
[[ ! -e "$data_dir/coach.sqlite-wal" && ! -e "$data_dir/coach.sqlite-shm" ]] || { printf '%s\n' "SQLite sidecars remain after the app was stopped." >&2; exit 1; }
"${compose[@]}" run --rm --no-deps app node scripts/restore-sqlite.mjs \
  --source=/data/backups/docker-snapshot.sqlite --target=/data/coach.sqlite \
  --confirm-target=/data/coach.sqlite --replace-existing
node --input-type=module - "$data_dir" <<'EOF'
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';
const data = process.argv[2];
const restored = new Database(path.join(data, 'coach.sqlite'), { readonly: true });
assert.equal(restored.prepare('SELECT value FROM deploy_restart_probe WHERE rowid=1').get().value, 'preserved');
restored.close();
const recovery = (await fs.readdir(data)).find((name) => name.startsWith('coach.sqlite.pre-restore-'));
assert.ok(recovery, 'restore must leave a pre-restore recovery copy');
const recoveryDb = new Database(path.join(data, recovery), { readonly: true });
assert.equal(recoveryDb.pragma('quick_check', { simple: true }), 'ok');
assert.equal(recoveryDb.prepare('SELECT value FROM deploy_restart_probe WHERE rowid=1').get().value, 'changed-after-backup');
recoveryDb.close();
EOF
"${compose[@]}" up -d app >/dev/null
healthy=0
for attempt in $(seq 1 45); do
  if node -e "fetch('http://127.0.0.1:$app_port/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then healthy=1; break; fi
  sleep 2
done
[[ "$healthy" == 1 ]] || { printf '%s\n' "Restored container did not become healthy." >&2; exit 1; }
"${compose[@]}" restart app >/dev/null
for attempt in $(seq 1 45); do
  if node -e "fetch('http://127.0.0.1:$app_port/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then healthy=1; break; else healthy=0; fi
  sleep 2
done
[[ "$healthy" == 1 ]] || { printf '%s\n' "Container did not become healthy after restart." >&2; exit 1; }
docker exec "$("${compose[@]}" ps -q app)" node -e "const D=require('better-sqlite3');const d=new D('/data/coach.sqlite',{readonly:true});if(d.prepare('SELECT value FROM deploy_restart_probe WHERE rowid=1').get().value!=='preserved')process.exit(1);d.close()"

printf '%s\n' "PASS: local/public Compose validation, production image build, Caddy config, explicit migrations, operator-owned data path, WAL writes, consistent online backup/confirmed restore, health, hostile Origin rejection, hosted browser login/callback/private-question navigation, non-root read-only runtime, no Git/SIWC service, and restart persistence."
