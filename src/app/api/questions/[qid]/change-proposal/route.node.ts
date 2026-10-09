import { chapterSet, companyQuestions, masterQuestions, questionIds } from "@/lib/content";
import { db } from "@/lib/db";
import { authSessionReader } from "@/lib/server/auth-session";
import { createQuestionChangeProposalHandlers, QuestionChangeProposalRepository, QuestionChangeProposalService } from "@/lib/server/question-change-proposals";
import { publicQuestionSnapshot, publicQuestionSnapshotSha256 } from "@/lib/server/question-public-content";

export const runtime = "nodejs";

const contentHashes = new Map([...masterQuestions, ...companyQuestions].map((question) => {
  const snapshot = publicQuestionSnapshot(question);
  return [question.qid, publicQuestionSnapshotSha256(snapshot)] as const;
}));
const service = new QuestionChangeProposalService(
  new QuestionChangeProposalRepository(db),
  questionIds,
  chapterSet.content_version,
  contentHashes,
);
const handlers = createQuestionChangeProposalHandlers(service, authSessionReader);

type Context = { params: Promise<{ qid: string }> };

export async function GET(request: Request, context: Context) {
  return handlers.read(request, context);
}

export async function POST(request: Request, context: Context) {
  return handlers.submit(request, context);
}

export async function DELETE(request: Request, context: Context) {
  return handlers.withdraw(request, context);
}
