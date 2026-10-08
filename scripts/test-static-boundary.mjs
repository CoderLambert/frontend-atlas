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

const coachSessionsRoute = path.join(outputRoot, "coach", "sessions", "index.html");
const coachSessionsRouteHtml = await readFile(coachSessionsRoute, "utf8").catch(() => "");
assert.match(coachSessionsRouteHtml, /404: This page could not be found\./u, "The server-saved account sessions route must remain a 404 in static export.");
assert.doesNotMatch(coachSessionsRouteHtml, /连接知序站点账号|新建会话标题|发送一条用户消息|还没有账号会话/u, "The static site must not render the server-backed account UI.");

const aiGuideRoute = path.join(outputRoot, "ai-assist", "index.html");
const aiGuideHtml = await readFile(aiGuideRoute, "utf8").catch(() => "");
assert.match(aiGuideHtml, /AI 辅助练习/u, "The static site must expose the AI setup guide.");
assert.match(aiGuideHtml, /git clone https:\/\/github\.com\/CoderLambert\/frontend-atlas\.git/u, "The guide must include exact setup commands.");
assert.match(aiGuideHtml, /git status --short/u, "The guide must tell people to check for local changes before updating.");
assert.match(aiGuideHtml, /git pull --ff-only/u, "The guide must use a non-forced update for an existing clone.");
assert.match(aiGuideHtml, /当前本机版未提供手机直接运行方案/u, "The guide must describe the mobile runtime boundary accurately.");
assert.match(aiGuideHtml, /真实 ChatGPT 账号登录、订阅用量授权与模型请求尚未实测/u, "The guide must state that live account testing is pending.");
assert.match(aiGuideHtml, /AI辅助/u, "The static navigation must make the AI guide discoverable.");
assert.doesNotMatch(aiGuideHtml, /Continue with ChatGPT/u, "The static guide must not present a nonfunctional login button.");

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
