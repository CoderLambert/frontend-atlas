import { parentPort, workerData } from "node:worker_threads";
import { openSqliteDatabase } from "../src/lib/db/sqlite.ts";
import {
  createQuestionChangeProposalHandlers,
  QuestionChangeProposalRepository,
  QuestionChangeProposalService,
} from "../src/lib/server/question-change-proposals.ts";
import { coachWriteRequestHeader } from "../src/lib/server/coach/write-request-guard.ts";

if (!parentPort) throw new Error("Question proposal worker requires a parent port.");

const { databasePath, ownerUserId, qid, input, summary } = workerData;
const opened = openSqliteDatabase(databasePath);
const sessions = {
  async getUserId() {
    return ownerUserId;
  },
};
const handlers = createQuestionChangeProposalHandlers(
  new QuestionChangeProposalService(new QuestionChangeProposalRepository(opened.db), new Set([qid])),
  sessions,
  { trustedOriginUrl: "http://localhost" },
);

parentPort.postMessage({ type: "ready" });
parentPort.once("message", async (message) => {
  if (message !== "start") throw new Error("Unexpected worker command.");
  try {
    const request = new Request(`http://localhost/api/questions/${qid}/change-proposal`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "origin": "http://localhost",
        "x-frontend-atlas-account-id": ownerUserId,
        [coachWriteRequestHeader.name]: coachWriteRequestHeader.value,
      },
      body: JSON.stringify({
        expectedGenerationId: input.generationId,
        expectedVersion: input.version,
        summary,
      }),
    });
    const response = await handlers.submit(request, { params: Promise.resolve({ qid }) });
    const body = await response.json();
    parentPort.postMessage({ type: "result", status: response.status, proposalId: body.proposal?.id ?? null, body });
  } finally {
    opened.client.close();
  }
});
