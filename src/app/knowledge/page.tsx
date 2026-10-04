import topicIndexJson from "@/content/topic-index.generated.json";
import { KnowledgeIndex } from "@/components/site/knowledge-index";
import type { TopicIndexItem } from "@/lib/content";

export const metadata = { title: "知识库" };

export default function KnowledgePage() {
  return <KnowledgeIndex topics={topicIndexJson as TopicIndexItem[]} />;
}
