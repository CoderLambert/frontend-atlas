import type { Metadata } from "next";
import "./globals.css";
import { SiteShell } from "@/components/site/site-shell";

export const metadata: Metadata = {
  title: {
    default: "知序 · 前端面试学习站",
    template: "%s · 知序",
  },
  description: "用完整知识章、盲答和自评，持续练习前端面试表达。",
  applicationName: "知序",
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <SiteShell>{children}</SiteShell>
      </body>
    </html>
  );
}
