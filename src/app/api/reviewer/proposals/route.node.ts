import { questionReviewHandlers } from "@/lib/server/question-review-service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return questionReviewHandlers.list(request);
}
