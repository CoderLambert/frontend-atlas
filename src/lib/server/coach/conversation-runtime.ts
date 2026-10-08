import { db } from "../../db/index.ts";
import { ConversationRepository } from "./conversation-repository.ts";
import { ConversationService } from "./conversation-service.ts";

export const conversationService = new ConversationService(new ConversationRepository(db));
