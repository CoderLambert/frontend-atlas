import { parentPort, workerData } from "node:worker_threads";
import { openSqliteDatabase } from "../src/lib/db/sqlite.ts";
import { QuestionChangeProposalRepository } from "../src/lib/server/question-change-proposals.ts";
import { QuestionReviewRepository, QuestionReviewService } from "../src/lib/server/question-review.ts";

if (!parentPort) throw new Error("Question review worker requires a parent port.");

const opened = openSqliteDatabase(workerData.databasePath);
parentPort.postMessage({ type: "ready" });
parentPort.once("message", (message) => {
  if (message !== "start") throw new Error("Unexpected worker command.");
  try {
    const result = workerData.mode === "review"
      ? new QuestionReviewService(
        new QuestionReviewRepository(opened.db),
        workerData.contentVersion,
        new Map([[workerData.baseline.qid, workerData.baseline]]),
      ).decide(workerData.userId, workerData.proposalId, workerData.body)
      : new QuestionChangeProposalRepository(opened.db).withdraw(workerData.userId, workerData.baseline.qid, workerData.proposalId);
    parentPort.postMessage({ type: "result", kind: result.kind });
  } finally {
    opened.client.close();
  }
});
