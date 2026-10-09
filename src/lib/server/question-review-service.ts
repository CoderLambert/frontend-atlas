import { chapterSet, companyQuestions, masterQuestions } from "../content.ts";
import { db } from "../db/index.ts";
import { verifiedAuthSessionReader } from "./auth-session.ts";
import { publicQuestionSnapshot } from "./question-public-content.ts";
import { createQuestionReviewHandlers, QuestionReviewRepository, QuestionReviewService } from "./question-review.ts";

const publicCatalog = new Map(
  [...masterQuestions, ...companyQuestions].map((question) => [question.qid, publicQuestionSnapshot(question)] as const),
);

export const questionReviewRepository = new QuestionReviewRepository(db);
export const questionReviewService = new QuestionReviewService(
  questionReviewRepository,
  chapterSet.content_version,
  publicCatalog,
);
export const questionReviewHandlers = createQuestionReviewHandlers(
  questionReviewService,
  verifiedAuthSessionReader,
);
