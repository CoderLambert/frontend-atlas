import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { QuestionPractice } from "@/components/site/question-practice";
import { chapters, chapterSet, companyQuestions, masterQuestions, questionById, questionWithPublicSource, topicById } from "@/lib/content";

export const dynamicParams = false;

export function generateStaticParams() {
  return [...masterQuestions, ...companyQuestions].map((question) => ({ qid: question.qid }));
}

export async function generateMetadata({ params }: { params: Promise<{ qid: string }> }): Promise<Metadata> {
  const { qid } = await params;
  const question = questionById(qid);
  return question ? { title: `${question.qid} · ${question.title}` } : { title: "题目未找到" };
}

export default async function QuestionPage({ params }: { params: Promise<{ qid: string }> }) {
  const { qid } = await params;
  const question = questionById(qid);
  if (!question) notFound();

  const topicId = "topic_id" in question ? question.topic_id : question.topic_ids[0];
  const topic = topicById(topicId);
  const chapter = chapters.find((candidate) => candidate.topic_id === topicId);
  const relatedQuestionIds = topic?.question_ids.filter((id) => id !== question.qid) ?? [];
  if (!topic || !chapter) notFound();
  const publicQuestion = questionWithPublicSource(question);

  return (
    <QuestionPractice
      question={publicQuestion}
      topicTitle={topic.subtopic}
      topicId={topicId}
      relatedQuestionIds={relatedQuestionIds}
      contentVersion={chapterSet.content_version}
    />
  );
}
