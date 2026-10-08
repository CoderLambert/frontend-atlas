"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Children, isValidElement, type ReactNode } from "react";
import { CodeBlock } from "@/components/ui/code-block";
import { CoachMarkdownImage, splitTrailingUnclosedFence } from "@/lib/coach-markdown.mjs";
import { safeMarkdownHref } from "@/lib/safe-markdown-url.mjs";

function ScrollableMarkdownTable({ children }: { children?: ReactNode }) {
  return (
    <div className="markdown-table-scroll" role="region" aria-label="可横向滚动的表格" tabIndex={0}>
      <table>{children}</table>
    </div>
  );
}

export function CoachMarkdown({ source, streaming }: { source: string; streaming: boolean }) {
  const { body, unfinishedCode } = splitTrailingUnclosedFence(source);
  return (
    <div className="coach-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: CoachMarkdownImage,
          a: ({ href, children }) => {
            const safe = safeMarkdownHref(href);
            return safe ? <a href={safe} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>;
          },
          table: ScrollableMarkdownTable,
          pre: ({ children }) => {
            const child = Children.toArray(children)[0];
            if (!isValidElement<{ className?: string; children?: ReactNode }>(child) || child.type !== "code") {
              return <pre className="markdown-code">{children}</pre>;
            }
            const code = typeof child.props.children === "string" ? child.props.children : String(child.props.children ?? "");
            const language = /language-([\w+-]+)/u.exec(child.props.className ?? "")?.[1];
            return streaming
              ? <pre className="markdown-code"><code>{code}</code></pre>
              : <CodeBlock code={code} language={language} />;
          },
        }}
      >
        {body}
      </ReactMarkdown>
      {unfinishedCode !== null && (
        <div className="coach-unclosed-code">
          <p>未闭合代码围栏，暂按纯文本展示</p>
          <pre className="markdown-code"><code>{unfinishedCode}</code></pre>
        </div>
      )}
    </div>
  );
}
