# Question private overrides

Question edits are saved as a private overlay, not as mutations to the checked-in public question bank.

- The verified Better Auth session supplies `owner_user_id`; request bodies cannot choose an owner.
- One `question_private_overrides` row exists per `(owner_user_id, qid)` and contains the private prompt, Markdown explanation, assessment checkpoints, trusted public base version, and an incrementing revision.
- Reads, writes, conflict checks, and deletion are owner-scoped. Removing an override reveals the public version again and does not delete practice history.
- Existing IndexedDB practice records are not uploaded or rewritten by this feature.
- The public JSON sources remain read-only at runtime. There is no browser route that approves or publishes an edit.

The stored `base_content_version` and private revision are the merge boundary for a later pull-request-style workflow. A future proposal must snapshot the reviewed private revision, record its public base version and review status, and require a separately authorized reviewer/operator to apply a checked-in content change. Submission must never imply approval, and ordinary site users must not receive a public-publish capability by default.
