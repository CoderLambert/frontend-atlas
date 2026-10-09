export type QuestionChangeProposalStatus = "submitted" | "withdrawn";

export type QuestionChangeProposal = {
  id: string;
  qid: string;
  sourceGenerationId: string;
  sourceOverrideVersion: number;
  baseContentVersion: string;
  title: string;
  explanationMarkdown: string;
  checkpoints: string[];
  summary: string;
  status: QuestionChangeProposalStatus;
  createdAt: string;
  updatedAt: string;
  withdrawnAt: string | null;
};
