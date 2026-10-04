import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "out");
const files = [];

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(location);
    else if (/\.(?:html|js|json|txt)$/iu.test(entry.name)) files.push(location);
  }
}

await stat(outputRoot).catch(() => {
  throw new Error("Static output was not found. Run npm run build before checking the publish boundary.");
});
await collect(outputRoot);

const coachRoute = path.join(outputRoot, "coach", "index.html");
const coachRouteHtml = await readFile(coachRoute, "utf8").catch(() => "");
assert.match(coachRouteHtml, /404: This page could not be found\./u, "The local-only coach route must remain a 404 in static export.");
assert.doesNotMatch(coachRouteHtml, /Continue with ChatGPT|AI 答题教练|练习反馈/u, "The static coach route must not render the local interactive UI.");

const forbidden = [
  "dynamic_agent_client",
  "chatgpt.tokens.use.direct",
  "auth.openai.com/api/accounts/authorize",
  "auth.openai.com/api/accounts/oauth/token",
  "auth.openai.com/.well-known/openid-configuration",
  "siwc-profiles.json",
  "code_verifier",
  "refresh_token",
  "access_token",
];
const hits = [];
for (const file of files) {
  const content = await readFile(file, "utf8");
  for (const marker of forbidden) {
    if (content.includes(marker)) hits.push(`${path.relative(outputRoot, file)} contains ${marker}`);
  }
}
assert.deepEqual(hits, [], `Local SIWC server/auth material leaked into static output:\n${hits.join("\n")}`);
process.stdout.write(`Static publish boundary passed (${files.length} output files scanned; local coach route is 404; no SIWC credentials/protocol endpoints found).\n`);
