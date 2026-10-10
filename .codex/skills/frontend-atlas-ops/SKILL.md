---
name: frontend-atlas-ops
description: Operate, deploy, update, troubleshoot, and verify this repository's Docker Compose deployment and SQLite data. Use for Frontend Atlas server operations; not for unrelated projects or application feature development.
---

# Frontend Atlas operations

Use the repository's deployment implementation as the source of truth. Before changing a server or data, read `AGENTS.md`, `docs/docker-deployment.md`, `deploy.sh`, `Dockerfile`, and the active Compose files (`compose.yaml` plus any mode-specific override). Do not recreate or replace the deployment system.

## Establish scope and preserve the host

- Confirm the user means the intended target server before deployment. Record hostname, user, OS, architecture, memory, free disk, deployment filesystem, Docker/Compose/Bash/flock availability, current Docker access, existing containers and services, databases, reverse proxies, and 80/443 listeners. A developer machine or build runner is not the target by default.
- If the target is uncertain, stop and ask. If dependencies are missing, state the minimal installation and impact and wait for approval. Do not change firewall/security-group rules, Docker permissions or groups, system services, or security controls without explicit approval. Never use root to bypass the deployment helper's operator checks.
- Use the configured SSH remote (`git@github.com:CoderLambert/frontend-atlas.git`) for repository operations. Verify SSH authentication and repository access before fetching. Do not put tokens or passwords in URLs, command arguments, shell history, logs, or chat.
- Inspect `git status`, remote, and HEAD before fetching or switching revisions. Preserve uncommitted edits, config, and data. Do not use `git reset --hard`, `git clean`, broad overwrites, or delete/recreate an existing deployment directory. Deploy an explicitly reviewed SHA; never silently follow `main` or the latest remote tip.

## Configuration and data safety

- Read the current script and Compose configuration to determine the actual service names, modes, ports, mounts, and commands. Keep the private `.env.deploy` out of Git and images; its required mode is `0600`. Enter Better Auth and optional provider credentials only in the server terminal with input hidden. Never print or copy secret values into conversation, logs, screenshots, test fixtures, or skill files; do not enable shell tracing.
- For public mode, `PUBLIC_URL` and runtime `BETTER_AUTH_URL` must be the exact HTTPS origin, with no path, wildcard, or custom port. OAuth callbacks are separate exact HTTPS URLs; check the provider console manually. A provider is unavailable unless both its client ID and secret are configured. Do not assume one provider's callback or an apex-domain callback covers another host.
- Keep deployment SQLite data separate from developer/local data. For this repository, the deployment database is `.local-data/deploy/coach.sqlite`; developer data may live at `.local-data/coach.sqlite`. Before first initialization, state the absolute database path and confirm no database already exists, then obtain explicit approval to create an empty one. If data exists, report its path/state and get confirmation before reuse or migration; take and verify a consistent backup first.
- Use `./deploy.sh backup NAME.sqlite` for online backups; it uses SQLite's online backup API and integrity check. Never copy only the live SQLite main file. Restore only after stopping the stack and only with the helper's exact target and interactive confirmation. Conduct restore drills in an isolated directory/database, never against production or through a second app sharing production SQLite. Preserve one app replica. Never use `docker compose down -v` for routine operations.
- If deployment or migrations fail, inspect sanitized logs, container health, mounts and ownership, required env presence (not values), migration status, SQLite integrity, ports, DNS, TLS, and proxy routing before choosing a cause-specific action. Do not blindly rerun, delete a volume/database, or auto-restore.

## Proxy and runtime invariants

- Re-check current port owners before changing networking. If Nginx, Caddy, or another site already owns 80/443, do not stop it or overwrite its configuration. Present a compatible proxy integration and wait for approval before changing host/network configuration.
- Observed live topology for `zhixu.lambert.host` (verify before each change): existing Nginx owns public 80/443 and preserves other sites; it terminates TLS using host Certbot/Let's Encrypt state under `/etc/letsencrypt` and forwards to Caddy on loopback port `18080`. Caddy's public-mode host mappings are loopback-only (`18080` and `18443`); the deployed Caddyfile serves HTTP behind Nginx. Certbot, not Caddy, currently renews the public certificate. The deployment checkout has a local `Caddyfile` topology change; inspect and preserve that diff during upgrades rather than force-overwriting it.
- Keep the app port internal/unpublished, do not start or proxy SIWC/ChatGPT services or port `4317`, and preserve the non-root container, read-only root filesystem, required bounded cache mounts, and single app replica. Verify actual runtime configuration instead of trusting defaults or CI.
- The site login is not AI authorization. Do not move local subscription/SIWC credentials, implement shared parent-domain cookies/tokens, enable cross-provider account linking, or grant the web container repository publishing access.

## Deploy and verify

Use the existing `./deploy.sh` commands after checking their current implementation:

```sh
./deploy.sh status
./deploy.sh logs
./deploy.sh down
./deploy.sh up
./deploy.sh backup NAME.sqlite
```

`logs` streams container output and is not itself a redactor. Review/filter before sharing; never dump `.env.deploy`, full container env, or unreviewed logs. Start only after resolving any existing-data or first-empty-database confirmation gate. Do not push images to an external registry unless separately requested.

Report every acceptance item as `PASS`, `FAIL`, `NOT_RUN`, or `NOT_VERIFIED`, with evidence and the reason for incomplete checks. Distinguish local-host curls from external access and CI evidence from this server. At minimum verify:

- exact checked-out SHA, local image ID (do not invent a registry digest), host architecture, one healthy non-root app container, read-only root, writable data/cache mounts, no app-port publication, and no SIWC port;
- public A and any AAAA records against the target, actual external HTTPS, certificate name/chain, HTTP-to-HTTPS behavior, and persistent certificate/renewal storage. A renewal dry-run is not a real renewal;
- home, question list/detail, full learning content/code/resources, `/account/`, browser console, and relevant server logs;
- real provider OAuth callback, login, refresh, and logout performed by the user (never mock these). Test private-content authorization, a wrong-Origin request against a real protected write interface without mutation, and cross-account isolation only when a second real test account exists;
- restart persistence using temporary test data saved through the normal application flow, not direct production database edits;
- a consistent backup and an isolated restore/integrity check;
- secret, token, cookie, config, and database exclusion from Git/build context/image/logs using checks that do not print matched values.

Do not claim a provider, external URL, browser behavior, successful write, account isolation, renewal, or persistence test passed unless it was actually exercised. Keep temporary test content clearly marked and remove it through the application only after the user approves or requests cleanup.

If an application code fix is needed, first record reproducible blocking evidence. Make the smallest fix on a separate branch, test and review it independently, and report the new exact SHA and difference from the approved release. Never present a repaired build as the originally approved SHA.

## Upgrade and rollback

Before an upgrade, inspect the working tree/remote and exact target SHA, preserve and reconcile deployment-local proxy/config edits, check the current stack, and make a fresh consistent backup. Fetch over SSH, review the candidate commit and its migration behavior, and switch only to the explicitly approved SHA. Then use `./deploy.sh up` to rebuild and apply the repository's forward migrations.

Do not imply that reverting only the image or code is a safe rollback after a schema migration. Database downgrade compatibility must be established for the exact versions. Any restore requires an outage, a verified backup, an explicit target confirmation, and awareness that post-backup writes will be lost.

## Current deployment reference

- Site origin: `https://zhixu.lambert.host`.
- Deployment directory on the confirmed host: `/home/ubuntu/apps/frontend-atlas`.
- Approved deployed release at skill creation: `c17ab676cd0a797fc44a7003de5efffa6d21ebb0`.
- GitHub OAuth callback: `https://zhixu.lambert.host/api/auth/callback/github`; Google is optional and is not configured in the current deployment.
- The private config, SQLite database, backups, and any local login/SIWC credentials are runtime/operator state and must never be copied into this skill or committed.

Treat these host details as an observed checkpoint, not permanent truth; inspect the live host and current repository files before every mutation.
