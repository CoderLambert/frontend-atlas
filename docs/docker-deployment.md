# Docker deployment

This deploys the learning site and its Better Auth account database. It does **not** move or enable the local ChatGPT/SIWC connection. The deployment builds the same pinned production image on the destination machine; it does not publish the image to a registry.

## Requirements and first start

Use a Linux host with Docker Engine, the Docker Compose v2 plugin, Bash, `flock` (from util-linux), and a working DNS name for public mode. Node.js is installed inside the image; the host-side initializer does not require Node.js or the npm toolchain. The Dockerfile uses the official `node:24.21.0-bookworm-slim` image and the optional HTTPS proxy uses the official `caddy:2.11.7-alpine` image. Run `npm run test:deployment-docker` on each target architecture; it reports the Docker daemon architecture and verifies an actual local image build. This task environment did not have access to the Docker daemon, so no container architecture is recorded as build-verified here. Do not infer support from the multi-architecture upstream tags alone.

From a clean checkout:

```sh
./deploy.sh
```

On its first run, the script asks whether to run locally or on a public domain. It creates `.env.deploy` with mode `0600`, prompts for a Better Auth secret without echoing it, and accepts optional GitHub or Google OAuth credentials. Supply a secret of 32–256 characters; the script does not generate or print a persistent credential. It refuses to overwrite an existing config. The committed `.env.deploy.example` is a template only. The setup validates the generated local loopback URL or public HTTPS DNS origin strictly; it does not accept a URL path, credentials, or custom port. Mutating commands use a per-checkout lock so concurrent deploy, backup, and restore operations cannot race; read-only status and streaming logs do not take that lock.

For a local-only check, choose `local`. The service binds only to `127.0.0.1:3010` by default and accepts plain HTTP only for loopback URLs. This mode is intentionally unsuitable for public access. Choose a different free local port during setup if needed.

For public mode, enter a DNS hostname such as `learn.example.com`. Set its A/AAAA records and allow inbound 80/443 at the host/network before starting. The included Caddy reverse proxy obtains and renews HTTPS certificates. The app has no published host port; only Caddy's 80/443 listeners are exposed. Do not put a path, credentials, query, or non-standard port in `PUBLIC_URL`.

The helper builds the image, validates the deployment settings, and asks before it creates a new empty database. Further starts apply migrations to the existing database. Missing databases are rejected by default. App credentials and the selected hostname are read at runtime, so changing `PUBLIC_URL` does not require rebuilding the image. Keep `BETTER_AUTH_URL` equal to `PUBLIC_URL`; the deployment validator enforces this. Better Auth's trusted origin is derived from that same configured URL. A domain change also requires updating the OAuth app callback settings.

## OAuth and domain setup

With `PUBLIC_URL=https://learn.example.com`, register these exact callback URLs in the chosen OAuth providers:

- GitHub: `https://learn.example.com/api/auth/callback/github`
- Google: `https://learn.example.com/api/auth/callback/google`

The provider ID and secret must be supplied as a pair. Without those values, that sign-in provider is not enabled. Better Auth uses the runtime `BETTER_AUTH_URL`; the callback origin and write-request Origin guard match the configured site origin. Caddy is the only public reverse proxy in this Compose setup. If you replace it with another trusted proxy, configure it to forward the original host and HTTPS scheme, reject unknown hosts, and avoid forwarding user-supplied `X-Forwarded-*` values. Do not expose the app port or SIWC port directly.

## Data, backups, and restore

The deployment database is in `./.local-data/deploy/coach.sqlite`, a separate location from the old local app's `.local-data/coach.sqlite`. Before the first Compose command, the helper creates/checks the data and backup directories and requires their UID/GID to match the unprivileged operator and configured container UID/GID. It fails closed if existing ownership differs and never runs `chown` or `chmod` on an existing data directory. New directories are created under a restrictive umask. The container process itself is non-root; it needs write access only to the database directory and Next.js cache. A startup migration and SQLite `quick_check` run before the web server starts.

Run a consistent online SQLite backup while the app is running:

```sh
./deploy.sh backup coach-2026-10-10.sqlite
```

The backup is made with SQLite's online backup API, checked with `quick_check`, and copied to `.local-data/backups/`. Copy that backup off the server as part of the operator's normal backup routine. The script will not overwrite an existing backup filename.

To restore, stop the stack, name both the backup and exact in-container database target, and type the confirmation word after reading the warning:

```sh
./deploy.sh down
./deploy.sh restore ./path/to/coach-2026-10-10.sqlite /data/coach.sqlite
./deploy.sh up
```

Restore refuses any app container state other than `exited` or `dead` (including `restarting`), unexpected SQLite WAL sidecar files, a mismatched confirmation target, or a source that fails integrity checking. The app stop state is checked again immediately after the typed confirmation. The per-checkout lock serializes `deploy.sh` operations; direct `docker compose` calls outside this helper are not covered by that lock. Replacing an existing database creates a `.pre-restore-*.sqlite` recovery copy and verifies it with `quick_check` before replacing the target; a failed recovery-copy check aborts replacement and retains the original database and copy for inspection. `./deploy.sh down` preserves both application data and Caddy's certificate volumes. Never use `docker compose down -v` for routine stop or upgrade; it removes the Caddy volumes and can destroy data if the volume layout is later changed.

Run exactly one app replica against this SQLite database. The conversation runtime and SQLite WAL are single-instance; do not share this directory between containers or hosts. Do not copy only `coach.sqlite` while the app is online; use the backup command. For a clean upgrade, keep the existing config/data directories, rebuild the image, then start the same Compose project. Startup applies forward migrations.

## ChatGPT/SIWC and operator boundary

The existing SIWC authorization is bound to its OAuth client: its callback is `http://127.0.0.1:4317/oauth/callback`, and the legacy browser coach calls that machine's loopback service. Those sessions are not transferable with the site image or database. This hosted build hides the local AI coach and SIWC-specific account-session screen and does not start SIWC; port 4317 is neither published nor reverse-proxied. Hosted site login and sign-out remain available at `/account/`, its Better Auth callback returns there, and the private-question editor links to that site-account screen. The hosted page does not offer cross-provider account linking; its OAuth entry points sign in to the site account only. `/ai-assist/` explains the boundary. No mock response is enabled or presented as real AI. A site login does not authorize ChatGPT/SIWC.

OpenAI documents a supported, user-controlled self-hosted VM flow for an open-source SIWC app: create a stable host ID for that VM, complete OAuth locally using the same tool/client, user, and workspace, then transfer that registration's protected credential file over a secure channel and let the VM manage refreshes. The localhost OAuth callback still reaches the browser's machine; it is not a callback URL for the public domain. This Docker setup does not implement or test that credential-transfer workflow and does not mount a profile/token volume. Do not put SIWC tokens in the image, `.env.deploy`, or a shared/multi-user service. A separately designed private SIWC runtime would need its own protected storage, host ID, and operator process, following [OpenAI's self-hosted VM instructions](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) and [SIWC Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/). Site OAuth accounts remain separate from ChatGPT/SIWC accounts.

Repository review/publication commands remain operator-only. Use a separate trusted repository checkout with Node.js 24, npm dependencies, Git and the required repository access for `npm run provider:bindings`, `npm run site:roles`, or `npm run question:publish`. The runtime image intentionally omits `.git`, Git, and operator scripts and does not receive repository credentials or release permissions. Do not grant the web container Git publishing rights.

## Operations

```sh
./deploy.sh status
./deploy.sh logs
./deploy.sh down
```

The local mode is for a single-machine smoke check and never binds a non-loopback address. Public mode expects Caddy to receive real DNS traffic on 80/443. A passing container health check proves that Next.js can answer and the mounted SQLite file passes `quick_check`; it does not verify external DNS, certificate issuance, OAuth provider registration, real user login, or AI availability.
