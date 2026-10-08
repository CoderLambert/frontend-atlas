import { createElement, type ComponentProps } from "react";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { harden } from "rehype-harden";
import {
  defaultComponents,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  type Components,
  type ExtraProps,
  type StreamdownProps,
  type UrlTransform,
} from "streamdown";
import { safeMarkdownHref } from "./safe-markdown-url.mjs";

function ScrollableMarkdownTable({ children }: ComponentProps<"table"> & ExtraProps) {
  return createElement(
    "div",
    { className: "markdown-table-scroll", role: "region", "aria-label": "可横向滚动的表格", tabIndex: 0 },
    createElement("table", null, children),
  );
}

function ScrollableCodeBlock({ children, ...props }: ComponentProps<"pre"> & ExtraProps) {
  return createElement(
    "div",
    { className: "markdown-code-scroll", role: "region", "aria-label": "可横向滚动的代码片段", tabIndex: 0 },
    createElement(defaultComponents.pre, props, children),
  );
}

function SafeMarkdownLink({ href, children }: ComponentProps<"a"> & ExtraProps) {
  const safe = safeMarkdownHref(href);
  return safe
    ? createElement("a", { href: safe, target: "_blank", rel: "noopener noreferrer" }, children)
    : createElement("span", null, children);
}

function SafeMarkdownImage({ alt }: ComponentProps<"img"> & ExtraProps) {
  if (!alt) return null;
  return createElement("span", { className: "coach-markdown-image-alt" }, `图片说明：${alt}`);
}

type CoachComponents = Pick<Components, "a" | "img" | "pre" | "table">;
const components = {
  a: SafeMarkdownLink as CoachComponents["a"],
  img: SafeMarkdownImage as CoachComponents["img"],
  pre: ScrollableCodeBlock as CoachComponents["pre"],
  table: ScrollableMarkdownTable as CoachComponents["table"],
} satisfies NonNullable<StreamdownProps["components"]>;

const urlTransform: UrlTransform = (url, key) => key === "href" ? safeMarkdownHref(url) : null;

const rehypePlugins = [
  defaultRehypePlugins.sanitize,
  [harden, {
    allowedLinkPrefixes: ["*"],
    allowedImagePrefixes: [],
    allowDataImages: false,
    linkBlockPolicy: "text-only",
    imageBlockPolicy: "text-only",
  }],
] satisfies NonNullable<StreamdownProps["rehypePlugins"]>;

export const COACH_MARKDOWN_OPTIONS = {
  components,
  controls: {
    code: { copy: true, download: false },
    table: { copy: false, download: false, fullscreen: false },
  },
  lineNumbers: false,
  codeBlockMaxHeight: 0,
  plugins: { code, cjk },
  rehypePlugins,
  remarkPlugins: Object.values(defaultRemarkPlugins),
  skipHtml: true,
  translations: { copyCode: "复制代码", copied: "已复制原始代码" },
  urlTransform,
} satisfies Pick<
  StreamdownProps,
  | "components"
  | "controls"
  | "lineNumbers"
  | "codeBlockMaxHeight"
  | "plugins"
  | "rehypePlugins"
  | "remarkPlugins"
  | "skipHtml"
  | "translations"
  | "urlTransform"
>;
