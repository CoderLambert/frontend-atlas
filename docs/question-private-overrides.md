# Private question overrides and device study profiles

Question edits are saved as a private SQLite overlay. The checked-in public question bank is never mutated by an ordinary user's edit.

## Ownership and concurrency

- The verified Better Auth session supplies `owner_user_id`; request bodies cannot choose an owner. Reads and writes always scope the SQL query by both `owner_user_id` and `qid`.
- One row exists per `(owner_user_id, qid)`. It stores the private title, Markdown explanation, self-assessment checkpoints, server-trusted `base_content_version`, `generation_id` and integer `version`.
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

## Future public proposal workflow

`base_content_version`, `generation_id` and private `version` are a review boundary, not a publication capability. A proposal must snapshot the exact private generation/revision, record the corresponding public base, keep explicit review status and require a separately authorized reviewer/operator to apply checked-in public content changes. Submission cannot imply approval, and ordinary users must not receive public-publish rights.
