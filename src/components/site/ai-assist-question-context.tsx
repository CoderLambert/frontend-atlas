"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowUpRight, FileQuestion } from "lucide-react";

export function AiAssistQuestionContext({ questionIds }: { questionIds: string[] }) {
  const searchParams = useSearchParams();
  const requestedId = searchParams.get("qid");
  if (!requestedId || !questionIds.includes(requestedId)) return null;

  const localCoachUrl = "http://127.0.0.1:3000/coach/?qid=" + encodeURIComponent(requestedId);
  return (
    <aside className="assist-question-context" aria-label="当前题目">
      <div className="assist-question-context-icon"><FileQuestion size={19} aria-hidden="true" /></div>
      <div>
        <strong>为 {requestedId} 准备的说明</strong>
        <p>完成下面的本机启动步骤后，这个链接会在本机教练中预选此题。当前答案不会放进链接。</p>
        <Link href={localCoachUrl}>启动后打开本题教练 <ArrowUpRight size={14} aria-hidden="true" /></Link>
      </div>
    </aside>
  );
}
