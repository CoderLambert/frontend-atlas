"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, Clock3, Database, FileQuestion, MessageSquareText, Search, Sparkles, WandSparkles } from "lucide-react";
import { cn } from "@/lib/cn";

const navigation = [
  { href: "/", label: "学习台", icon: BookOpen },
  { href: "/questions/", label: "题库", icon: FileQuestion },
  { href: "/knowledge/", label: "知识库", icon: BookOpen },
  { href: "/review/", label: "复习", icon: Clock3 },
];

const isLocalCoachEnabled = process.env.NEXT_PUBLIC_FRONTEND_ATLAS_LOCAL_MODE === "1";
const localNavigation = isLocalCoachEnabled
  ? [...navigation, { href: "/coach/sessions/", label: "账号会话", icon: MessageSquareText }, { href: "/coach/", label: "AI答题教练", icon: WandSparkles }]
  : [...navigation, { href: "/ai-assist/", label: "AI辅助", icon: WandSparkles }];

function isCurrent(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  if (href === "/coach/") return pathname === "/coach/";
  return pathname.startsWith(href);
}

export function SiteShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const current = pathname.startsWith("/data/") ? "本设备数据" : localNavigation.find((item) => isCurrent(pathname, item.href))?.label ?? "学习台";

  return (
    <div className={cn("app-frame", isLocalCoachEnabled && "has-local-coach")}>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <aside className="desktop-sidebar" aria-label="主导航">
        <Link className="brand-lockup" href="/" aria-label="知序，返回学习台">
          <span className="brand-mark" aria-hidden="true">知</span>
          <span className="brand-copy"><strong>知序</strong><small>FRONTEND ATLAS</small></span>
        </Link>
        <nav className="primary-nav">
          {localNavigation.map(({ href, label, icon: Icon }) => {
            const active = isCurrent(pathname, href);
            return (
              <Link key={href} href={href} className={cn("nav-link", active && "is-active")} aria-current={active ? "page" : undefined}>
                <Icon aria-hidden="true" size={20} strokeWidth={1.8} />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-footnote">
          <Link className="sidebar-data-link" href="/data/"><Database size={17} aria-hidden="true" />本设备数据</Link>
          <div className="local-indicator"><span aria-hidden="true" />本设备学习记录</div>
          <p>进度只保存在这个浏览器中</p>
        </div>
      </aside>

      <div className="app-main-column">
        <header className="topbar">
          <Link className="mobile-brand" href="/" aria-label="知序，返回学习台">
            <span className="mobile-brand-mark" aria-hidden="true">知</span>
            <span>知序</span>
          </Link>
          <div className="breadcrumbs" aria-label="当前位置"><span>知序</span><span aria-hidden="true">/</span><strong>{current}</strong></div>
          <Link className="search-entry" href="/questions/" aria-label="搜索题目和知识点">
            <Search size={18} aria-hidden="true" />
            <span>搜索题目、知识点</span>
            <kbd aria-hidden="true">⌘ K</kbd>
          </Link>
          <Link className="mobile-search" href="/questions/" aria-label="搜索题目和知识点"><Search size={22} /></Link>
          <Link className="mobile-data-link" href="/data/" aria-label="本设备数据"><Database size={20} /></Link>
        </header>

        <main id="main-content" className="main-content">{children}</main>
        <footer className="site-footer"><Sparkles size={14} aria-hidden="true" /><span>你的内容，由你掌握</span><span className="footer-dot">·</span><span>仅此浏览器保存</span></footer>
      </div>

      <nav className="mobile-nav" aria-label="底部导航">
        {localNavigation.map(({ href, label, icon: Icon }) => {
          const active = isCurrent(pathname, href);
          return (
            <Link key={href} href={href} className={cn("mobile-nav-link", active && "is-active")} aria-current={active ? "page" : undefined}>
              <Icon aria-hidden="true" size={20} strokeWidth={1.8} />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
