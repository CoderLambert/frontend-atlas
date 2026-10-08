"use client";

import { Streamdown } from "streamdown";
import { COACH_MARKDOWN_OPTIONS } from "@/lib/coach-markdown-config";

export function CoachMarkdown({ source, streaming }: { source: string; streaming: boolean }) {
  return (
    <div className="coach-markdown">
      <Streamdown
        {...COACH_MARKDOWN_OPTIONS}
        className="coach-markdown-render"
        mode={streaming ? "streaming" : "static"}
        isAnimating={streaming}
      >
        {source}
      </Streamdown>
    </div>
  );
}
