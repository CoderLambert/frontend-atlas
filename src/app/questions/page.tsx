import questionIndexJson from "@/content/question-index.generated.json";
import topicIndexJson from "@/content/topic-index.generated.json";
import { QuestionBank } from "@/components/site/question-bank";
import type { QuestionIndexItem, TopicIndexItem } from "@/lib/content";

export const metadata = { title: "题库" };

export default function QuestionsPage() {
  return <QuestionBank questions={questionIndexJson as QuestionIndexItem[]} topics={topicIndexJson as TopicIndexItem[]} />;
}
