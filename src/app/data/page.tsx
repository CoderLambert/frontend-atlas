import questionIndexJson from "@/content/question-index.generated.json";
import contentManifestJson from "@/content/content-manifest.generated.json";
import { DataManager } from "@/components/site/data-manager";
import type { QuestionIndexItem } from "@/lib/content";

export const metadata = { title: "本设备数据" };

export default function DataPage() {
  const questions = questionIndexJson as QuestionIndexItem[];
  return <DataManager knownQids={questions.map((question) => question.qid)} contentSetVersion={contentManifestJson.contentVersion} />;
}
