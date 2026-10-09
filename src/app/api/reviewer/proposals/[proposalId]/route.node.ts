import { questionReviewHandlers } from "@/lib/server/question-review-service";

export const runtime = "nodejs";

type Context = { params: Promise<{ proposalId: string }> };

export async function GET(request: Request, context: Context) {
  const { proposalId } = await context.params;
  return questionReviewHandlers.detail(request, proposalId);
}

export async function POST(request: Request, context: Context) {
  const { proposalId } = await context.params;
  return questionReviewHandlers.decide(request, proposalId);
}
