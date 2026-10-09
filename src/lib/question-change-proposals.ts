export type QuestionChangeProposalStatus = "submitted" | "withdrawn" | "approved" | "rejected" | "published";

export type QuestionChangeProposal = {
  id: string;
  qid: string;
  sourceGenerationId: string;
  sourceOverrideVersion: number;
  baseContentVersion: string;
  baseContentSha256: string;
  title: string;
  explanationMarkdown: string;
  checkpoints: string[];
  summary: string;
  status: QuestionChangeProposalStatus;
  createdAt: string;
  updatedAt: string;
  withdrawnAt: string | null;
};

export type QuestionChangeProposalHistory = QuestionChangeProposal & {
  review: {
    decision: "approved" | "rejected";
    comment: string;
    decidedAt: string;
  } | null;
};
