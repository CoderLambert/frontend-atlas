import { notFound } from "next/navigation";
import { CoachAccountSessions } from "@/components/site/coach-account-sessions";
import { questionIds } from "@/lib/content";

export const metadata = { title: "账号会话" };

export default function CoachSessionsPage() {
  if (process.env.FRONTEND_ATLAS_LOCAL_MODE !== "1") notFound();
  return <CoachAccountSessions knownQids={[...questionIds]} />;
}
