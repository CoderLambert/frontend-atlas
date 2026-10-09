import { questionIds } from "@/lib/content";
import { db } from "@/lib/db";
import { authSessionReader } from "@/lib/server/auth-session";
import { createQuestionChangeProposalHandlers, QuestionChangeProposalRepository, QuestionChangeProposalService } from "@/lib/server/question-change-proposals";

export const runtime = "nodejs";

const service = new QuestionChangeProposalService(new QuestionChangeProposalRepository(db), questionIds);
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
