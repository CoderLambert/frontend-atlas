"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyCodeText } from "@/lib/copy-code.mjs";
import type { HighlightResult } from "@/lib/code-highlighter";

const MAX_HIGHLIGHT_LENGTH = 50_000;

function languageIsSupported(language: string) {
  return /^(js|mjs|cjs|javascript|ts|mts|cts|typescript|jsx|tsx|jsonc|json5|json|html|xml|css|scss|bash|sh|shell|sql|py|python|yaml|yml|markdown|md)$/iu.test(language.trim());
}

export function CodeBlock({ code, language, plain = false }: { code: string; language?: string; plain?: boolean }) {
  const [highlightState, setHighlightState] = useState<{ key: string; result: HighlightResult | null; failed: boolean } | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canHighlight = !plain && Boolean(language && languageIsSupported(language)) && code.length <= MAX_HIGHLIGHT_LENGTH;
  const hasPlainFallback = Boolean(language && (!languageIsSupported(language) || code.length > MAX_HIGHLIGHT_LENGTH));
  const highlightKey = `${language ?? ""}\u0000${code}`;

  useEffect(() => {
    let active = true;
    if (canHighlight && language) {
      void import("@/lib/code-highlighter").then(({ highlightCode }) => highlightCode(code, language)).then((result) => {
        if (!active) return;
        setHighlightState({ key: highlightKey, result, failed: !result });
      }).catch(() => {
        if (active) setHighlightState({ key: highlightKey, result: null, failed: true });
      });
    }
    return () => { active = false; };
  }, [canHighlight, code, highlightKey, language]);

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  async function copy() {
    const copied = await copyCodeText(code);
    setCopyState(copied ? "copied" : "failed");
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyState("idle"), 2200);
  }

  const currentHighlight = !plain && highlightState?.key === highlightKey ? highlightState : null;
  const highlight = currentHighlight?.result ?? null;
  const highlightFailed = Boolean(currentHighlight?.failed);
  const lines = highlight?.tokens;
  return (
    <div className="shared-code-block">
      <div className="shared-code-toolbar">
        <span>{language || "代码"}{(highlightFailed || hasPlainFallback) && <span className="code-fallback-label"> · 纯文本</span>}</span>
        <div className="shared-code-actions">
          {copyState === "failed" && <span className="code-copy-feedback" role="status">复制不可用，请选中代码手动复制。</span>}
          {copyState === "copied" && <span className="code-copy-feedback" role="status">已复制原始代码</span>}
          <button className="code-copy-button" type="button" onClick={() => void copy()} aria-label="复制代码">
            {copyState === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            <span>{copyState === "copied" ? "已复制" : copyState === "failed" ? "重试复制" : "复制"}</span>
          </button>
        </div>
      </div>
      <pre className="code-block shared-code-content" tabIndex={0} aria-label={`${language || "代码"}代码片段`}>
        <code>
          {lines
            ? lines.map((line, lineIndex) => (
              <span className="code-highlight-line" key={lineIndex}>
                {line.map((token, tokenIndex) => (
                  <span key={`${lineIndex}-${tokenIndex}`} style={{ color: token.color, backgroundColor: token.bgColor, fontStyle: token.fontStyle && token.fontStyle & 1 ? "italic" : undefined, fontWeight: token.fontStyle && token.fontStyle & 2 ? 700 : undefined, textDecoration: token.fontStyle && token.fontStyle & 4 ? "underline" : undefined }}>{token.content}</span>
                ))}
              </span>
            ))
            : code}
        </code>
      </pre>
    </div>
  );
}
