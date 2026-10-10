export function validateDeploymentConfig(env = process.env) {
  const errors = [];
  const mode = env.DEPLOYMENT_MODE;
  const publicUrl = env.FRONTEND_ATLAS_PUBLIC_URL ?? env.PUBLIC_URL;
  const authUrl = env.BETTER_AUTH_URL;
  const secret = env.BETTER_AUTH_SECRET;
  let parsedUrl;

  if (env.FRONTEND_ATLAS_DEPLOYMENT_MODE !== "hosted") errors.push("hosted runtime mode is required");
  if (mode !== "local" && mode !== "public") errors.push("DEPLOYMENT_MODE must be local or public");
  try {
    parsedUrl = new URL(publicUrl);
    if (parsedUrl.origin !== publicUrl || parsedUrl.pathname !== "/" || parsedUrl.search || parsedUrl.hash || parsedUrl.username || parsedUrl.password) {
      errors.push("PUBLIC_URL must be an origin only, without a path, query, fragment, or credentials");
    }
  } catch {
    errors.push("PUBLIC_URL must be a valid absolute HTTP(S) URL");
  }
  if (parsedUrl) {
    if (authUrl !== publicUrl) errors.push("BETTER_AUTH_URL must exactly match PUBLIC_URL");
    if (mode === "local") {
      const localNames = new Set(["localhost", "127.0.0.1", "[::1]"]);
      if (parsedUrl.protocol !== "http:" || !localNames.has(parsedUrl.hostname)) {
        errors.push("local mode only permits HTTP on localhost or a loopback address");
      }
    }
    if (mode === "public") {
      const labels = parsedUrl.hostname.split(".");
      const validDnsName = labels.length >= 2
        && parsedUrl.hostname.length <= 253
        && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label));
      if (parsedUrl.protocol !== "https:" || !validDnsName || parsedUrl.port) {
        errors.push("public mode requires an HTTPS DNS hostname on the standard port");
      }
      if (env.PUBLIC_HOST !== parsedUrl.hostname) errors.push("PUBLIC_HOST must match the hostname in PUBLIC_URL");
    }
  }
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 256) {
    errors.push("BETTER_AUTH_SECRET must be provided and contain 32 to 256 characters");
  }
  for (const [idName, secretName] of [["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"], ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]]) {
    if (Boolean(env[idName]) !== Boolean(env[secretName])) errors.push(`${idName} and ${secretName} must be configured as a pair`);
  }
  if (!/^[0-9]+$/u.test(env.APP_UID ?? "") || Number(env.APP_UID) < 1 || !/^[0-9]+$/u.test(env.APP_GID ?? "")) {
    errors.push("APP_UID must be a non-root numeric user ID and APP_GID a numeric group ID");
  }
  if (mode === "local" && (!/^[0-9]+$/u.test(env.APP_PORT ?? "") || Number(env.APP_PORT) < 1 || Number(env.APP_PORT) > 65_535)) {
    errors.push("APP_PORT must be a numeric TCP port");
  }
  return { ok: errors.length === 0, errors, origin: parsedUrl?.origin ?? null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = validateDeploymentConfig();
  if (!result.ok) {
    process.stderr.write(`Deployment configuration is invalid: ${result.errors.join("; ")}\n`);
    process.exit(1);
  }
  process.stdout.write("Deployment configuration is valid.\n");
}
