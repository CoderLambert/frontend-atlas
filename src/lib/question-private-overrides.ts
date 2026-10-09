import type { ContentBlock } from "@/lib/content";

export type QuestionPrivateOverride = {
  qid: string;
  baseContentVersion: string;
  title: string;
  explanationMarkdown: string;
  checkpoints: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export function contentBlocksToMarkdown(blocks: ContentBlock[]) {
  return blocks.map((block) => {
    if (block.kind === "heading") return `### ${block.text}`;
    if (block.kind === "code") return `\`\`\`${block.language ?? "text"}\n${block.text}\n\`\`\``;
    const links = block.links?.map((link) => `[${link.label}](${link.target})`).join(" · ");
    return links ? `${block.text}\n\n${links}` : block.text;
  }).join("\n\n");
}
