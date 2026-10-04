import { notFound } from "next/navigation";
import { CoachWorkspace, type CoachQuestion } from "@/components/site/coach-workspace";
import { chapterSet, questionIndex } from "@/lib/content";

export const metadata = { title: "AI答题教练" };

export default function CoachPage() {
  if (process.env.FRONTEND_ATLAS_LOCAL_MODE !== "1") notFound();
  const questions: CoachQuestion[] = questionIndex.map(({ qid, title, primary, subtopic, kind }) => ({
    qid, title, primary, subtopic, kind,
  }));
  return <CoachWorkspace questions={questions} contentVersion={chapterSet.content_version} />;
}
