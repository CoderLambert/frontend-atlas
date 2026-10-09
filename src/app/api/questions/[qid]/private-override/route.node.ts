import { chapterSet, companyQuestions, masterQuestions, questionIds } from "@/lib/content";
import { db } from "@/lib/db";
import { authSessionReader } from "@/lib/server/auth-session";
import { createQuestionPrivateOverrideHandlers, QuestionPrivateOverrideRepository, QuestionPrivateOverrideService } from "@/lib/server/question-private-overrides";
import { publicQuestionSnapshot, publicQuestionSnapshotSha256 } from "@/lib/server/question-public-content";

export const runtime = "nodejs";

const contentHashes = new Map([...masterQuestions, ...companyQuestions].map((question) => {
  const snapshot = publicQuestionSnapshot(question);
  return [question.qid, publicQuestionSnapshotSha256(snapshot)] as const;
}));
const service = new QuestionPrivateOverrideService(new QuestionPrivateOverrideRepository(db), questionIds, chapterSet.content_version, contentHashes);
const handlers = createQuestionPrivateOverrideHandlers(service, authSessionReader);

type Context = { params: Promise<{ qid: string }> };

export async function GET(request: Request, context: Context) {
  return handlers.read(request, context);
}

export async function PATCH(request: Request, context: Context) {
  return handlers.save(request, context);
}

export async function DELETE(request: Request, context: Context) {
  return handlers.delete(request, context);
}
