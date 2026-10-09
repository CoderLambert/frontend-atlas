import assert from "node:assert/strict";
import { isConfirmedAccountLink } from "../src/lib/account-link-state.ts";
import { accountLinkCallbackPath, createAuthPostRouteHandler } from "../src/lib/server/auth-post-route-handler.ts";

const delegated = [];
const handler = createAuthPostRouteHandler({
  delegate: async (request) => {
    delegated.push({
      url: request.url,
      body: await request.clone().json().catch(() => null),
    });
    return Response.json({ delegated: true });
  },
  sessions: { async getUserId() { return "mock-user-b"; } },
  verifiedSessions: { async getUserId() { return "oauth-user-a"; } },
  configuredProviders: { github: true, google: false },
});

function request(path, body, expectedAccountId = "oauth-user-a", contentType = "application/json") {
  const headers = new Headers({ "content-type": contentType });
  if (expectedAccountId) headers.set("x-frontend-atlas-account-id", expectedAccountId);
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let response = await handler(request("/api/auth/link-social", { provider: "github" }));
assert.equal(response.status, 200);
assert.equal(delegated.length, 1);
assert.deepEqual(delegated[0].body, {
  provider: "github",
  callbackURL: "/coach/sessions/?accountLink=success&accountLinkProvider=github",
  errorCallbackURL: "/coach/sessions/?accountLink=failed&accountLinkProvider=github",
  disableRedirect: true,
}, "the server, not the client, supplies the fixed same-origin callback contract");
assert.equal(accountLinkCallbackPath("google", "success"), "/coach/sessions/?accountLink=success&accountLinkProvider=google");
assert.equal(isConfirmedAccountLink({
  result: "success",
  callbackProvider: "google",
  pending: { accountId: "oauth-user-a", provider: "google" },
  accountId: "oauth-user-b",
  linkedProviders: ["google"],
}), false, "switching accounts invalidates a pending provider link even when the new account has that provider");
assert.equal(isConfirmedAccountLink({
  result: "success",
  callbackProvider: "google",
  pending: { accountId: "oauth-user-a", provider: "google" },
  accountId: "oauth-user-a",
  linkedProviders: ["github", "google"],
}), true);

response = await handler(request("/api/auth/link-social", { provider: "github" }, "mock-user-b"));
assert.equal(response.status, 409, "a local Mock identity cannot authorize a real OAuth link operation");
assert.equal((await response.json()).error, "account_changed");
assert.equal(delegated.length, 1);

response = await handler(request("/api/auth/link-social", { provider: "github" }, null));
assert.equal(response.status, 409, "the displayed account id is mandatory");
assert.equal(delegated.length, 1);

const invalidBodies = [
  { provider: "google" },
  { provider: "discord" },
  { provider: "github", idToken: "client-token" },
  { provider: "github", scopes: ["repo"] },
  { provider: "github", additionalParams: { prompt: "consent" } },
  { provider: "github", additionalData: { role: "admin" } },
  { provider: "github", callbackURL: "https://evil.example/callback" },
  { provider: "github", errorCallbackURL: "https://evil.example/error" },
  { provider: "github", disableRedirect: false },
  { provider: "github", proxyURL: "https://evil.example/proxy" },
  { provider: "github", loginHint: "other@example.test" },
  {},
  [],
];
for (const body of invalidBodies) {
  response = await handler(request("/api/auth/link-social", body));
  assert.equal(response.status, 400, `invalid link body was not rejected: ${JSON.stringify(body)}`);
  assert.equal((await response.json()).error, "invalid_link_request");
}
response = await handler(request("/api/auth/link-social", "{", "oauth-user-a"));
assert.equal(response.status, 400, "malformed JSON is rejected");
response = await handler(request("/api/auth/link-social", { provider: "github" }, "oauth-user-a", "text/plain"));
assert.equal(response.status, 400, "non-JSON link requests are rejected");
assert.equal(delegated.length, 1, "invalid link attempts never reach Better Auth");

response = await handler(request("/api/auth/sign-out", {} , "mock-user-b"));
assert.equal(response.status, 200, "local Mock sign-out retains its existing account guard");
assert.equal(delegated.length, 2);
response = await handler(request("/api/auth/sign-out", {}, "oauth-user-a"));
assert.equal(response.status, 409);
assert.equal(delegated.length, 2);

process.stdout.write("Auth link route tests passed.\n");
