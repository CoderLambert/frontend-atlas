import type { HighlighterCore, LanguageRegistration, ThemedToken } from "shiki/core";

const MAX_HIGHLIGHT_LENGTH = 50_000;
const THEME = "github-light";

const aliases: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", javascript: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", typescript: "typescript",
  jsx: "jsx", tsx: "tsx", jsonc: "jsonc", json5: "json5", json: "json",
  html: "html", xml: "xml", css: "css", scss: "scss", bash: "bash", sh: "bash", shell: "bash",
  sql: "sql", py: "python", python: "python", yaml: "yaml", yml: "yaml", markdown: "markdown", md: "markdown",
};

type LanguageModule = { default: LanguageRegistration[] };
const languageLoaders: Record<string, () => Promise<LanguageModule>> = {
  javascript: () => import("@shikijs/langs/javascript"),
  typescript: () => import("@shikijs/langs/typescript"),
  jsx: () => import("@shikijs/langs/jsx"),
  tsx: () => import("@shikijs/langs/tsx"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  json5: () => import("@shikijs/langs/json5"),
  html: () => import("@shikijs/langs/html"),
  xml: () => import("@shikijs/langs/xml"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  bash: () => import("@shikijs/langs/bash"),
  sql: () => import("@shikijs/langs/sql"),
  python: () => import("@shikijs/langs/python"),
  yaml: () => import("@shikijs/langs/yaml"),
  markdown: () => import("@shikijs/langs/markdown"),
};

type TokenHighlighter = Pick<HighlighterCore, "loadLanguage" | "codeToTokens">;
let highlighterPromise: Promise<TokenHighlighter> | null = null;
let languageQueue = Promise.resolve();
const languagePromises = new Map<string, Promise<void>>();

function canonicalLanguage(language: string) {
  const normalized = language.trim().toLowerCase().replace(/^language-/u, "").split(/[\s,;]/u, 1)[0];
  return aliases[normalized] ?? null;
}

async function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("@shikijs/themes/github-light"),
    ]).then(([core, engine, theme]) => core.createHighlighterCore({
      engine: engine.createJavaScriptRegexEngine(),
      themes: [theme.default],
      warnings: false,
    }));
  }
  return highlighterPromise;
}

async function ensureLanguage(highlighter: TokenHighlighter, language: string) {
  let pending = languagePromises.get(language);
  if (!pending) {
    const loader = languageLoaders[language];
    if (!loader) throw new Error("Unsupported language");
    pending = languageQueue.then(async () => {
      const registration = await loader();
      await highlighter.loadLanguage(...registration.default);
    });
    languagePromises.set(language, pending);
    languageQueue = pending.catch(() => undefined);
  }
  return pending;
}

export type HighlightResult = { tokens: ThemedToken[][]; foreground?: string; background?: string };

export async function highlightCode(code: string, language: string): Promise<HighlightResult | null> {
  const normalized = canonicalLanguage(language);
  if (!normalized || code.length > MAX_HIGHLIGHT_LENGTH) return null;
  try {
    const highlighter = await getHighlighter();
    await ensureLanguage(highlighter, normalized);
    const result = highlighter.codeToTokens(code, { lang: normalized as never, theme: THEME as never });
    return { tokens: result.tokens, foreground: result.fg, background: result.bg };
  } catch {
    return null;
  }
}
