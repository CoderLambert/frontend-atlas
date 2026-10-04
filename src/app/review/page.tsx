import questionIndexJson from "@/content/question-index.generated.json";
import { ReviewQueue } from "@/components/site/review-queue";
import { chapterSet } from "@/lib/content";
import type { QuestionIndexItem } from "@/lib/content";

export const metadata = { title: "复习" };

export default function ReviewPage() {
  const questions = questionIndexJson as QuestionIndexItem[];
  return <ReviewQueue questions={questions.map(({ qid, title, topicIds }) => ({ qid, title, topicId: topicIds[0] ?? "" }))} contentVersion={chapterSet.content_version} />;
}
