type RevisionedQuestion = { content_revision?: string };

export function questionContentVersion(question: RevisionedQuestion, contentVersion: string) {
  return question.content_revision ? `${contentVersion}:${question.content_revision}` : contentVersion;
}
