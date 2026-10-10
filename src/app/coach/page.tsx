import { notFound } from "next/navigation";
import { CoachWorkspace, type CoachQuestion } from "@/components/site/coach-workspace";
import { chapterSet, questionIndex } from "@/lib/content";

export const metadata = { title: "AI答题教练" };

type CoachSearchParams = Promise<{ qid?: string | string[] }>;

export default async function CoachPage({ searchParams }: { searchParams: CoachSearchParams }) {
  if (process.env.FRONTEND_ATLAS_LOCAL_MODE !== "1" || process.env.FRONTEND_ATLAS_DEPLOYMENT_MODE === "hosted") notFound();
  const questions: CoachQuestion[] = questionIndex.map(({ qid, title, primary, subtopic, kind }) => ({
    qid, title, primary, subtopic, kind,
  }));
  const params = await searchParams;
  const requestedQid = Array.isArray(params.qid) ? params.qid[0] : params.qid;
  const initialQuestionId = questions.some((question) => question.qid === requestedQid) ? requestedQid! : "D13";
  return <CoachWorkspace questions={questions} contentVersion={chapterSet.content_version} initialQuestionId={initialQuestionId} />;
}
