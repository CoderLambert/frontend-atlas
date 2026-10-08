import { db } from "../../db/index.ts";
import { ConversationRepository } from "./conversation-repository.ts";
import { ConversationService } from "./conversation-service.ts";
import { AssistantRunManager } from "./assistant-run-manager.ts";

type ConversationRuntime = {
  database: typeof db;
  conversationService: ConversationService;
  assistantRunManager: AssistantRunManager;
};

type ConversationRuntimeGlobal = typeof globalThis & {
  __frontendAtlasConversationRuntime?: ConversationRuntime;
};

function createConversationRuntime(database: typeof db): ConversationRuntime {
  const conversationService = new ConversationService(new ConversationRepository(database));
  conversationService.recoverUnfinishedAssistantRuns();
  return {
    database,
    conversationService,
    assistantRunManager: new AssistantRunManager(conversationService),
  };
}

const runtimeGlobal = globalThis as ConversationRuntimeGlobal;
const currentRuntime = runtimeGlobal.__frontendAtlasConversationRuntime;
// This SQLite runtime supports one Node process per database file; it does not coordinate across processes.
// globalThis survives Next.js dev HMR, so the same handle keeps one service and manager.
const runtime = currentRuntime?.database === db
  ? currentRuntime
  : createConversationRuntime(db);
runtimeGlobal.__frontendAtlasConversationRuntime = runtime;

export const conversationService = runtime.conversationService;
export const assistantRunManager = runtime.assistantRunManager;
