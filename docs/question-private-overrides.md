# Private question overrides and device study profiles

Question edits are saved as a private SQLite overlay. The checked-in public question bank is never mutated by an ordinary user's edit.

## Ownership and concurrency

- The verified Better Auth session supplies `owner_user_id`; request bodies cannot choose an owner. Reads and writes always scope the SQL query by both `owner_user_id` and `qid`.
- One row exists per `(owner_user_id, qid)`. It stores the private title, Markdown explanation, self-assessment checkpoints, server-trusted `base_content_version` and `base_content_sha256`, `generation_id` and integer `version`.
- Each creation assigns a new server-generated UUID `generation_id`. PATCH and DELETE require both `expectedGenerationId` and `expectedVersion`; a mismatched generation or revision returns HTTP 409.
- Deleting an override restores the public question without deleting learning history. A later recreation starts at v1 **but uses a different generation**. Old tabs cannot modify/delete the recreated row.
- The practice `effectiveContentVersion` includes public version, account ID, generation and revision, so self-assessment scores tied to an earlier generation are not reused.
- Migration `0005` extends already-applied `0004` rows with a generated generation ID without changing their content or historical versions. Migration scripts must be tested with temporary databases; do not silently recreate or reset real SQLite data.

## Local study records

- New practice attempts and revision drafts are tagged with a Better Auth owner in local server mode. Static mode and signed-out records are device-local legacy records with no owner.
- IndexedDB v3 adds a separate `accountDrafts` store; the old `drafts` key path is unchanged. Old, ownerless records are preserved and **never automatically claimed** by whichever user next signs in.
- Question practice, question bank, review queue and progress views show only records for the active account (or the legacy device profile when signed out). Account changes invalidate pending page loads and clear prior account's visible state.
- `/data/` remains an explicitly **device-wide** data manager: its exports, replacement and clearing include every account's records on that browser and legacy data. The UI warns that these operations affect all device profiles. Do not mistake in-app IndexedDB filtering for cryptographically secure multi-user isolation.
- Offline device data is not automatically uploaded to the server. Truly confidential A/B isolation on a shared browser requires encrypted per-account storage or server session-authorized records; do not claim the local storage is a security boundary.
- The existing offline AI conversation storage is device-local, not Better Auth user-private. This feature does not convert or erase historical conversations.

## Deployment modes and performance

- Local server mode exposes the owner-scoped API and private Markdown editor.
- Static export mode excludes `*.node.ts` API handlers and does not mount a private editor or request those APIs.
- Markdown/Streamdown/Shiki continue to load only on demand.

## Public change proposals

- A signed-in user can submit the current private generation/revision as a public change proposal with a required review summary. The server reads the source override under the verified session owner and snapshots its title, Markdown explanation, checkpoints and server-trusted public base; client-supplied content is ignored.
- A retry for the same source generation/revision is idempotent. Only one active proposal exists per owner and question. A changed private version cannot replace the active snapshot; the user must explicitly withdraw it first.
- Withdrawing marks the proposal `withdrawn` and retains the immutable snapshot for audit. Resetting or editing the private override never changes or deletes a submitted proposal.
- Proposal reads and withdrawals are owner-scoped. Guessing another proposal ID cannot expose or withdraw it.
- Migration `0006` adds proposal storage and a partial unique index for the active `(owner_user_id, qid)` boundary.

Submission is not approval, and approval is not publication. Migration `0009` adds the controlled review/publication workflow below; migration `0010` adds database-level delete and publication-transition guards for the audit trail. Existing proposal rows are preserved with an empty content hash and intentionally fail closed until a new private revision is saved and submitted against a trusted current base.

## Reviewer and operator grants

- Roles are server-side SQLite grants keyed only by a Better Auth `user.id`. Email, OAuth provider, first login, request bodies and client state never grant a role.
- A trusted local administrator can list, grant and revoke roles with `npm run site:roles -- ...`. Grant/revoke rows keep `createdBy`, `createdAt`, `revokedBy` and `revokedAt`; revocation never deletes review or publication history.
- The CLI refuses to create a missing database and prints only role audit metadata. It does not read or display account/session tokens.

```sh
npm run site:roles -- list --user-id <better-auth-user-id>
npm run site:roles -- grant --user-id <id> --role reviewer --created-by <local-admin>
npm run site:roles -- revoke --user-id <id> --role reviewer --revoked-by <local-admin>
```

## Trusted review

- `/moderation/questions/` and `/api/reviewer/*` use the verified Better Auth session, then check an active reviewer grant. Local Mock identities are not accepted. The static export renders this route as 404.
- Queue responses expose only the applicant ID/name and proposal metadata needed for review; email, OAuth accounts, sessions and credentials are never selected.
- Detail responses derive the title, Markdown and checkpoint diff on the server from checked-in canonical content and the immutable proposal snapshot. Client-supplied diffs are ignored.
- A reviewer cannot decide their own proposal. Submitted proposals expire after 30 days. The decision transaction rechecks the reviewer grant, proposal source revision, expiry, public content version/hash and terminal status under `BEGIN IMMEDIATE` semantics. Competing review/withdrawal requests produce one terminal winner.
- Review rows bind reviewer ID, decision, comment, proposal revision, public base version/hash and time. Database triggers make proposal snapshot fields and review rows immutable. Exact retries are idempotent; different later decisions fail with 409.
- Applicants can see the status and review comment for their own proposal history, never another owner's history. A rejected proposal can only be followed by a newly saved private revision and a new proposal; the old audit row remains.

## Controlled Git publication

There is no Route Handler that writes the Git worktree. A trusted operator runs the local CLI from a clean repository whose `HEAD` equals the selected base ref:

```sh
npm run question:publish -- prepare \
  --proposal-id <approved-proposal-id> \
  --operator-user-id <better-auth-user-id> \
  --base-ref origin/main
```

`prepare` rechecks the operator grant and approved review, reads all question content from SQLite, verifies the global content version and per-question SHA-256, and edits the real `knowledge-map.source.json` and `knowledge-chapters.source.json` in a disposable Git worktree. It runs `scripts/generate-content-index.mjs`, restricts the commit to canonical source/generated content files, then creates a deterministic local branch and commit whose message contains the proposal ID. It never accepts question text on the command line, changes the operator's checkout, pushes, opens a PR or merges. Dirty worktrees, wrong repositories/bases, validation failures and public-content conflicts leave canonical content and publication audit unchanged.

After a human-reviewed publication PR has actually merged, reconcile against the trusted target ref:

```sh
npm run question:publish -- reconcile \
  --proposal-id <approved-proposal-id> \
  --operator-user-id <better-auth-user-id> \
  --target-ref origin/main
```

`reconcile` does not accept a client commit SHA. It resolves the Git ref itself, requires the prepared commit to be an ancestor, locates the first merge-path descendant, and re-reads canonical source plus generated index/manifest from that Git tree. Only then does it atomically mark the publication and proposal `published`. A prepared commit or branch is not a merged publication.

## Regression commands

In addition to the existing private/OAuth/chat/legacy suites, run:

```sh
npm run test:question-review
npm run test:question-publication
npm run test:question-review-migration
npm run test:question-review-browser
```

The tests use temporary SQLite databases and fixture Git repositories. They cover authorization, owner isolation, trusted diff generation, self-review, forged identity fields, competing reviewers, review/withdraw races, immutable audit rows, stale bases, revoked roles, publication failure cleanup, deterministic source/index commits, idempotency, Git ancestry/content reconciliation, restart and backup/restore.
