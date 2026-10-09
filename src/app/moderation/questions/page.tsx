import { headers } from "next/headers";
import { forbidden, notFound } from "next/navigation";
import { ReviewerDashboard } from "@/components/site/reviewer-dashboard";

export const metadata = { title: "公共题库审核" };

export default async function QuestionModerationPage() {
  if (process.env.FRONTEND_ATLAS_LOCAL_MODE !== "1") notFound();

  // Keep database/auth imports out of the static export graph. This page only
  // exists in the local application runtime.
  const [{ verifiedAuthSessionReader }, { questionReviewService }] = await Promise.all([
    import("@/lib/server/auth-session"),
    import("@/lib/server/question-review-service"),
  ]);
  const request = new Request("http://frontend-atlas.local/moderation/questions/", { headers: await headers() });
  const reviewerUserId = await verifiedAuthSessionReader.getUserId(request);
  if (!reviewerUserId || questionReviewService.access(reviewerUserId).kind !== "allowed") forbidden();

  return <ReviewerDashboard />;
}
