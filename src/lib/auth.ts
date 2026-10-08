import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { db } from "./db";
import * as schema from "./db/schema";

const githubClientId = process.env.GITHUB_CLIENT_ID;
const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const authSecret = process.env.BETTER_AUTH_SECRET;
const authBaseUrl = process.env.BETTER_AUTH_URL;

export const auth = authSecret && authBaseUrl ? betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    baseURL: authBaseUrl,
    secret: authSecret,
    basePath: "/api/auth",
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
      },
    },
    socialProviders: {
      ...(githubClientId && githubClientSecret ? { github: { clientId: githubClientId, clientSecret: githubClientSecret } } : {}),
      ...(googleClientId && googleClientSecret ? { google: { clientId: googleClientId, clientSecret: googleClientSecret } } : {}),
    },
  }) : null;
