import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openSqliteDatabase } from "../src/lib/db/sqlite.ts";
import {
  presentPublication,
  prepareQuestionPublication,
  QuestionPublicationRepository,
  reconcileQuestionPublication,
} from "../src/lib/server/question-publication.ts";

const projectRoot = realpathSync(resolve(fileURLToPath(new URL("..", import.meta.url))));
const args = process.argv.slice(2);
const command = args.shift();

function argument(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function usage() {
  process.stderr.write([
    "Trusted public-question publication:",
    "  npm run question:publish -- prepare --proposal-id <id> --operator-user-id <better-auth-user-id> [--repo <path>] [--base-ref <ref>]",
    "  npm run question:publish -- reconcile --proposal-id <id> --operator-user-id <better-auth-user-id> [--repo <path>] [--target-ref <ref>]",
    "",
    "prepare reads the approved immutable snapshot from SQLite; question content is never accepted on the command line.",
    "It creates a local branch and commit only. It never pushes, opens a PR, or merges.",
  ].join("\n") + "\n");
}

const allowedFlags = command === "prepare"
  ? new Set(["--proposal-id", "--operator-user-id", "--repo", "--base-ref"])
  : new Set(["--proposal-id", "--operator-user-id", "--repo", "--target-ref"]);
const structurallyValid = args.length % 2 === 0 && args.every((value, index) => index % 2 === 1 || allowedFlags.has(value));

let opened;
try {
  if ((command !== "prepare" && command !== "reconcile") || !structurallyValid) {
    usage();
    process.exitCode = 2;
  } else {
    const proposalId = argument("--proposal-id");
    const operatorUserId = argument("--operator-user-id");
    const configuredRepo = argument("--repo") ?? projectRoot;
    const repoPath = realpathSync(isAbsolute(configuredRepo) ? configuredRepo : resolve(process.cwd(), configuredRepo));
    const configuredDatabase = process.env.FRONTEND_ATLAS_DB_PATH ?? "./.local-data/coach.sqlite";
    const databasePath = isAbsolute(configuredDatabase) ? configuredDatabase : resolve(projectRoot, configuredDatabase);
    if (!proposalId || !operatorUserId) {
      usage();
      process.exitCode = 2;
    } else if (!existsSync(databasePath)) {
      throw new Error(`Refusing to create an empty SQLite database at ${databasePath}.`);
    } else {
      opened = openSqliteDatabase(databasePath);
      const repository = new QuestionPublicationRepository(opened.db);
      const result = command === "prepare"
        ? prepareQuestionPublication(repository, {
          repoPath,
          baseRef: argument("--base-ref") ?? process.env.FRONTEND_ATLAS_PUBLICATION_BASE_REF ?? "origin/main",
          operatorUserId,
          proposalId,
        })
        : reconcileQuestionPublication(repository, {
          repoPath,
          targetRef: argument("--target-ref") ?? process.env.FRONTEND_ATLAS_PUBLICATION_TARGET_REF ?? "origin/main",
          operatorUserId,
          proposalId,
        });
      if (result.kind === "forbidden") throw new Error("The Better Auth user does not have an active operator grant.");
      if (result.kind === "not-found") throw new Error("Proposal not found.");
      if (result.kind === "not-approved") throw new Error("Only an approved, unreleased proposal can be prepared.");
      if (result.kind === "not-prepared") throw new Error("No prepared publication exists for this proposal.");
      if (result.kind === "not-merged") throw new Error("The target Git ref does not contain the prepared publication commit.");
      if (result.kind === "merge-conflict") throw new Error("Publication was already reconciled against a different merge commit.");
      if (!("publication" in result)) throw new Error(`Publication failed closed: ${result.kind}.`);
      process.stdout.write(JSON.stringify({ result: result.kind, publication: presentPublication(result.publication) }, null, 2) + "\n");
    }
  }
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
} finally {
  opened?.client.close();
}
