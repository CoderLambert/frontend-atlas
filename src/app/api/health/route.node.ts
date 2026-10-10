import { database } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  try {
    const result = database.client.pragma("quick_check", { simple: true });
    if (result !== "ok") return Response.json({ status: "unhealthy" }, { status: 503 });
    return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ status: "unhealthy" }, { status: 503 });
  }
}
