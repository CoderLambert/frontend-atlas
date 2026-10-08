"use client";

import { useMemo, useState } from "react";
import { Streamdown } from "streamdown";
import { COACH_MARKDOWN_OPTIONS } from "@/lib/coach-markdown-config";

export function CoachMarkdown({ source, streaming }: { source: string; streaming: boolean }) {
  const [copyError, setCopyError] = useState(false);
  const controls = useMemo(() => ({
    ...COACH_MARKDOWN_OPTIONS.controls,
    code: {
      copy: {
        onCopy: () => setCopyError(false),
        onError: () => setCopyError(true),
      },
      download: false,
    },
  }), []);

  return (
    <div className="coach-markdown">
      <Streamdown
        {...COACH_MARKDOWN_OPTIONS}
        controls={controls}
        className="coach-markdown-render"
        mode={streaming ? "streaming" : "static"}
        isAnimating={streaming}
      >
        {source}
      </Streamdown>
      {copyError && <p className="coach-markdown-copy-error" role="status" aria-live="polite">复制失败，请检查浏览器剪贴板权限后重试。</p>}
    </div>
  );
}
