"use client";

import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

export function ReviewerNavLink({ mobile, active }: { mobile?: boolean; active: boolean }) {
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    let epoch = 0;
    let controller: AbortController | null = null;
    const load = () => {
      const current = ++epoch;
      controller?.abort();
      controller = new AbortController();
      setAllowed(false);
      void fetch("/api/reviewer/access", { credentials: "same-origin", cache: "no-store", signal: controller.signal })
        .then((response) => {
          if (current === epoch && response.ok) setAllowed(true);
        })
        .catch((cause: unknown) => {
          if (!(cause instanceof Error && cause.name === "AbortError") && current === epoch) setAllowed(false);
        });
    };
    load();
    if (typeof BroadcastChannel === "undefined") return () => controller?.abort();
    const channel = new BroadcastChannel("frontend-atlas-site-account");
    channel.onmessage = load;
    return () => {
      epoch += 1;
      controller?.abort();
      channel.close();
    };
  }, []);

  if (!allowed) return null;
  return (
    <Link
      href="/moderation/questions/"
      className={cn(mobile ? "mobile-nav-link" : "nav-link", active && "is-active")}
      aria-current={active ? "page" : undefined}
      data-testid="reviewer-navigation"
    >
      <ShieldCheck aria-hidden="true" size={20} strokeWidth={1.8} />
      <span>题库审核</span>
    </Link>
  );
}
