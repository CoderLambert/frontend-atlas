export type AssistantProviderMessage = { role: "user" | "assistant"; content: string };
export type AssistantProvider = {
  name: "local-mock" | "siwc-chatgpt";
  model: string | null;
  bindingVersion: number | null;
  stream(input: {
    content: string;
    messages: AssistantProviderMessage[];
    model: string | null;
    signal: AbortSignal;
  }): AsyncIterable<string>;
};

function isLocalRequest(request: Request) {
  try {
    const hostname = new URL(request.url).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false;
  }
}

export function isMockAssistantEnabled(request: Request) {
  return process.env.NODE_ENV === "development"
    && process.env.FRONTEND_ATLAS_LOCAL_MODE === "1"
    && process.env.FRONTEND_ATLAS_MOCK_ASSISTANT === "1"
    && isLocalRequest(request);
}

export function getAssistantProvider(request: Request): AssistantProvider | null {
  if (!isMockAssistantEnabled(request)) return null;
  return createLocalMockAssistantProvider();
}

function waitForChunk(signal: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    const finish = (aborted: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(aborted);
    };
    const onAbort = () => finish(true);
    const timer = setTimeout(() => finish(false), 160);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) finish(true);
  });
}

export function createLocalMockAssistantProvider(): AssistantProvider {
  return {
    name: "local-mock",
    model: null,
    bindingVersion: null,
    async *stream({ signal }) {
      const response = [
        "**本机 Mock 流式演示**\n\n",
        "这里没有连接真实 AI，也不会编造对你问题的回答。此段只用于验收消息持久化、流式显示和 Markdown 代码块。\n\n",
        "```ts\n",
        'const provider = "未连接";\n',
        "console.log(provider);\n",
        "```\n\n",
        "Mock 运行结束后，刷新会话仍可查看这段演示内容。",
      ].join("");
      const chunks = response.match(/[\s\S]{1,16}/g) ?? [response];
      for (const chunk of chunks) {
        if (signal.aborted) return;
        if (await waitForChunk(signal)) return;
        yield chunk;
      }
    },
  };
}
