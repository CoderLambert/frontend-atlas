<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## React and Next.js best practices

- For new or modified React/Next.js code and reviews, read and apply the available `vercel:react-best-practices` skill. If it is unavailable in the current environment, state that clearly and do not claim it was used.
- Apply relevant rules to the actual change: avoid async waterfalls; preserve on-demand bundle loading (including Shiki languages and themes); check Hook dependencies and cleanup; derive state during render; keep component identities stable at module scope; and review TypeScript correctness and accessibility.
- Optimize for measured or user-visible cost. Do not add memoization mechanically.
- Summarize applicable rules and material findings in review or handoff notes. Passing lint or typecheck does not replace this skill review.
