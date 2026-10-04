import topicIndexJson from "@/content/topic-index.generated.json";
import { chapterSet } from "@/lib/content";
import { KnowledgeIndex } from "@/components/site/knowledge-index";
import type { TopicIndexItem } from "@/lib/content";

export const metadata = { title: "知识库" };

export default function KnowledgePage() {
  const exerciseCount = chapterSet.chapters.reduce((total, chapter) => total + chapter.exercises.length, 0);
  return <KnowledgeIndex topics={topicIndexJson as TopicIndexItem[]} exerciseCount={exerciseCount} />;
}
