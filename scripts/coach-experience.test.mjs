import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { code } from "@streamdown/code";
import { Streamdown } from "streamdown";
import { copyCodeText } from "../src/lib/copy-code.mjs";
import { COACH_MARKDOWN_OPTIONS } from "../src/lib/coach-markdown-config.ts";
import { afterPreparation, createRequestEpoch, createRequestLifecycle, flushRequestBuffer, takeRequestBuffer } from "../src/lib/request-epoch.mjs";
import { safeMarkdownHref } from "../src/lib/safe-markdown-url.mjs";
import { highlightCode } from "../src/lib/code-highlighter.ts";

function renderCoachMarkdown(source, streaming = false) {
  return renderToStaticMarkup(createElement(Streamdown, {
    ...COACH_MARKDOWN_OPTIONS,
    className: "coach-markdown-render",
    mode: streaming ? "streaming" : "static",
    isAnimating: streaming,
  }, source));
}

test("copyCodeText sends the untouched source, including Unicode, indentation, and final newline", async () => {
  const source = "  const greeting = '你好 👋';\n\treturn greeting;\n";
  let copied = null;
  const ok = await copyCodeText(source, { async writeText(value) { copied = value; } });
  assert.equal(ok, true);
  assert.equal(copied, source);
});

test("copyCodeText reports unavailable and rejected clipboard writes", async () => {
  assert.equal(await copyCodeText("x", undefined), false);
  assert.equal(await copyCodeText("x", { async writeText() { throw new Error("denied"); } }), false);
});

test("Markdown links allow secure schemes only", () => {
  assert.equal(safeMarkdownHref("https://example.com/a"), "https://example.com/a");
  assert.equal(safeMarkdownHref("mailto:hello@example.com"), "mailto:hello@example.com");
  assert.equal(safeMarkdownHref("javascript:alert(1)"), null);
  assert.equal(safeMarkdownHref("data:text/html,hello"), null);
  assert.equal(safeMarkdownHref("/local/path"), null);
});

test("Streamdown renders CJK, English, GFM tables, and an accessible horizontal table region", () => {
  const source = "你好**世界**。\n\nEnglish answer text.\n\n| 项目 | 说明 |\n| --- | --- |\n| React | 组件库 |";
  const markup = renderCoachMarkdown(source);
  assert.match(markup, /data-streamdown="strong">世界<\/span>/u);
  assert.match(markup, /English answer text/u);
  assert.match(markup, /<table/u);
  assert.match(markup, /role="region" aria-label="可横向滚动的表格" tabindex="0"/u);
});

test("Streamdown raw HTML stays inert and strict URL filtering rejects unsafe schemes", () => {
  const source = "<script>alert(1)</script>\n\n[https](https://example.com/a) [mail](mailto:hello@example.com) [unsafe](javascript:alert(1)) [irc](irc://example.com) [blob](blob:https://example.com/id)";
  const markup = renderCoachMarkdown(source);
  assert.match(markup, /href="https:\/\/example\.com\/a"/u);
  assert.match(markup, /href="mailto:hello@example\.com"/u);
  assert.doesNotMatch(markup, /<script|href="(?:javascript|irc|blob):/iu);
  assert.doesNotMatch(markup, /Blocked URL|\[blocked\]/u);
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
});

test("Streamdown images become inert alt text in streaming and static output", () => {
  const source = "![面试答案](https://tracking.example/pixel?answer=private-content)";
  for (const stage of ["streaming", "final"]) {
    const markup = renderCoachMarkdown(source, stage === "streaming");
    assert.match(markup, /面试答案/u, stage);
    assert.doesNotMatch(markup, /<img|tracking\.example|private-content/iu, stage);
  }
});

test("Streamdown uses Shiki languages and falls back for unknown language identifiers", () => {
  assert.equal(code.supportsLanguage("typescript"), true);
  assert.equal(code.supportsLanguage("made-up-language"), false);
  const markup = renderCoachMarkdown("```not-a-real-language\nconst answer = '保持为文本';\n```");
  assert.match(markup, /role="region" aria-label="可横向滚动的代码片段" tabindex="0"/u);
  assert.match(markup, /aria-label="复制代码"/u);
  assert.doesNotMatch(markup, /<script|dangerouslySetInnerHTML/iu);
});

test("Streamdown parses an unfinished fence during streaming and disables partial-copy", () => {
  const markup = renderCoachMarkdown("思路如下\n\n```ts\nconst partial = '还在生成';", true);
  assert.match(markup, /data-incomplete="true"/u);
  assert.match(markup, /const partial = &#x27;还在生成&#x27;/u);
  assert.match(markup, /aria-label="复制代码"[^>]*disabled=""/u);
});

test("Shiki highlights supported languages, preserves source text, and falls back for unknown or oversized code", async () => {
  const source = "const greeting: string = '你好';\n";
  const highlighted = await highlightCode(source, "ts");
  const reconstructed = highlighted?.tokens.map((line) => line.map((token) => token.content).join("")).join("\n");
  assert.equal(reconstructed, source);
  assert.ok(highlighted?.tokens.flat().some((token) => token.color));
  assert.equal(await highlightCode(source, "made-up-language"), null);
  assert.equal(await highlightCode("x".repeat(50_001), "ts"), null);
});

test("request epochs ignore canceled and superseded stream updates while retry uses a fresh epoch", () => {
  const epoch = createRequestEpoch();
  const first = epoch.next();
  assert.equal(epoch.isCurrent(first), true);
  epoch.invalidate();
  assert.equal(epoch.isCurrent(first), false);

  const retry = epoch.next();
  assert.notEqual(retry, first);
  assert.equal(epoch.isCurrent(retry), true);
  const newer = epoch.next();
  assert.equal(epoch.isCurrent(retry), false);
  assert.equal(epoch.isCurrent(newer), true);
});

test("a delayed local draft save cannot send a canceled or superseded request", async () => {
  const makeDeferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };

  for (const action of ["stop", "change question", "logout", "unmount"]) {
    const lifecycle = createRequestLifecycle();
    const { request } = lifecycle.begin();
    const saved = makeDeferred();
    let sent = false;
    const pending = afterPreparation(request, lifecycle.isCurrent, () => saved.promise, () => { sent = true; });
    lifecycle.invalidate();
    saved.resolve();
    assert.equal(await pending, false, action);
    assert.equal(sent, false, action);
  }

  const lifecycle = createRequestLifecycle();
  const first = lifecycle.begin().request;
  const firstSave = makeDeferred();
  let firstSent = false;
  const pendingFirst = afterPreparation(first, lifecycle.isCurrent, () => firstSave.promise, () => { firstSent = true; });
  const second = lifecycle.begin().request;
  const secondSave = makeDeferred();
  let secondSent = false;
  const pendingSecond = afterPreparation(second, lifecycle.isCurrent, () => secondSave.promise, () => { secondSent = true; });
  firstSave.resolve();
  assert.equal(await pendingFirst, false);
  assert.equal(firstSent, false);
  secondSave.resolve();
  assert.equal(await pendingSecond, true);
  assert.equal(secondSent, true);
});

test("stop preserves the final buffered delta and an old stream cannot flush into a retry", () => {
  const lifecycle = createRequestLifecycle();
  const first = lifecycle.begin().request;
  first.buffer = "last delta";
  lifecycle.invalidate();
  const stoppedTail = takeRequestBuffer(first);
  let visible = "partial ";
  if (stoppedTail) visible += stoppedTail;
  assert.equal(visible, "partial last delta");

  const oldStream = lifecycle.begin().request;
  oldStream.buffer = "old stream tail";
  const retry = lifecycle.begin().request;
  retry.buffer = "retry output";
  let committed = "";
  assert.equal(flushRequestBuffer(oldStream, lifecycle.isCurrent, (text) => { committed += text; }), false);
  assert.equal(oldStream.buffer, "old stream tail");
  assert.equal(retry.buffer, "retry output");
  assert.equal(committed, "");
  assert.equal(flushRequestBuffer(retry, lifecycle.isCurrent, (text) => { committed += text; }), true);
  assert.equal(committed, "retry output");
});
