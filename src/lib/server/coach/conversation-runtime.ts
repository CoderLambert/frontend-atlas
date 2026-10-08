import { db } from "../../db/index.ts";
import { ConversationRepository } from "./conversation-repository.ts";
import { ConversationService } from "./conversation-service.ts";
import { AssistantRunManager } from "./assistant-run-manager.ts";

export const conversationService = new ConversationService(new ConversationRepository(db));
export const assistantRunManager = new AssistantRunManager(conversationService);
