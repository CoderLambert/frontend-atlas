"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { BookOpen, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { TopicIndexItem } from "@/lib/content";

export function KnowledgeIndex({ topics, exerciseCount }: { topics: TopicIndexItem[]; exerciseCount: number }) {
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState("all");
  const domains = useMemo(() => Array.from(new Set(topics.map((topic) => topic.primary))), [topics]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return topics.filter((topic) => {
      if (domain !== "all" && topic.primary !== domain) return false;
      if (normalized && !topic.searchText.includes(normalized)) return false;
      return true;
    }).sort((a, b) => a.topicId.localeCompare(b.topicId, "en"));
  }, [topics, query, domain]);

  return (
    <div className="content-page knowledge-index-page">
      <header className="content-page-header">
        <div><div className="eyebrow">KNOWLEDGE MAP · 从原理出发</div><h1>知识库</h1><p>{topics.length} 章完整正文、示例、边界与章节练习。先修关系和题目映射来自现有资料。</p></div>
        <div className="bank-counts"><span><strong>{topics.length}</strong> 个知识章节</span><span><strong>{exerciseCount}</strong> 道章节练习</span></div>
      </header>
      <Card className="knowledge-filters">
        <div className="knowledge-search"><Search size={18} aria-hidden="true" /><Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索章节、原理或关键词" aria-label="搜索知识章节、原理或关键词" /></div>
        <div className="knowledge-domain-filter"><Label className="filter-label" htmlFor="knowledge-domain">知识领域</Label><Select value={domain} onValueChange={setDomain}><SelectTrigger id="knowledge-domain"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部领域</SelectItem>{domains.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select></div>
        <p className="filter-summary">显示 {filtered.length} / {topics.length} 个章节</p>
      </Card>
      {filtered.length === 0 ? (
        <Card className="empty-state"><Search size={26} aria-hidden="true" /><h2>没有找到匹配章节</h2><p>试试其他关键词或切换知识领域。</p></Card>
      ) : (
        <div className="knowledge-chapter-grid">
          {filtered.map((topic) => (
            <Card className="knowledge-chapter-card" key={topic.topicId}>
              <Link className="knowledge-chapter-link" href={"/knowledge/" + topic.topicId + "/"}>
                <div className="knowledge-chapter-meta"><Badge variant="outline">{topic.topicId}</Badge><span>{topic.primary}</span></div>
                <h2>{topic.subtopic}</h2>
                <span className="knowledge-chapter-count">{topic.masterQuestionIds.length} 道主练题 · {topic.companyQuestionIds.length} 道企业变体</span>
                <span className="knowledge-prerequisite"><BookOpen size={14} aria-hidden="true" />先修：{topic.prerequisites.length ? topic.prerequisites.join(" · ") : "无"}</span>
              </Link>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
