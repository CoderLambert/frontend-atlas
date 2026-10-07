import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import ReactMarkdown from "react-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import { copyCodeText } from "../src/lib/copy-code.mjs";
import { CoachMarkdownImage, splitTrailingUnclosedFence } from "../src/lib/coach-markdown.mjs";
import { afterPreparation, createRequestEpoch, createRequestLifecycle, flushRequestBuffer, takeRequestBuffer } from "../src/lib/request-epoch.mjs";
import { safeMarkdownHref } from "../src/lib/safe-markdown-url.mjs";
import { highlightCode } from "../src/lib/code-highlighter.ts";

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

test("splitTrailingUnclosedFence leaves closed Markdown fences intact", () => {
  const source = "Before\n```ts\nconst x = 1;\n```\nAfter";
  assert.deepEqual(splitTrailingUnclosedFence(source), { body: source, unfinishedCode: null });
});

test("splitTrailingUnclosedFence returns only the unfinished code as plain text", () => {
  const source = "Before\n~~~typescript\n  const x = '保留';\n";
  assert.deepEqual(splitTrailingUnclosedFence(source), {
    body: "Before\n",
    unfinishedCode: "  const x = '保留';\n",
  });
});

test("Markdown links allow secure schemes only", () => {
  assert.equal(safeMarkdownHref("https://example.com/a"), "https://example.com/a");
  assert.equal(safeMarkdownHref("mailto:hello@example.com"), "mailto:hello@example.com");
  assert.equal(safeMarkdownHref("javascript:alert(1)"), null);
  assert.equal(safeMarkdownHref("data:text/html,hello"), null);
  assert.equal(safeMarkdownHref("/local/path"), null);
});

test("react-markdown does not interpret raw HTML or unsafe link protocols", () => {
  const markup = renderToStaticMarkup(createElement(ReactMarkdown, null, "<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))"));
  assert.doesNotMatch(markup, /<script|href="javascript:/iu);
});

test("Markdown images render only their alt text during streaming and final output", () => {
  const source = "![面试答案](https://tracking.example/pixel?answer=private-content)";
  for (const stage of ["streaming", "final"]) {
    const markup = renderToStaticMarkup(createElement(ReactMarkdown, { components: { img: CoachMarkdownImage } }, source));
    assert.match(markup, /图片说明：面试答案/u, stage);
    assert.doesNotMatch(markup, /<img|tracking\.example|private-content/iu, stage);
  }
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
