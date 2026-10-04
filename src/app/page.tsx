import Link from "next/link";
import { BookOpen, Clock3, FileQuestion, Layers3, LibraryBig, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { chapterSet, chapters, companyQuestions, masterQuestions, questionMap, topics } from "@/lib/content";
import { StudyStatusContent } from "@/components/site/study-status";

const formatCount = (count: number) => new Intl.NumberFormat("zh-CN").format(count);

const domainSummary = Array.from(new Set(topics.map((topic) => topic.primary))).map((primary) => {
  const domainTopics = topics.filter((topic) => topic.primary === primary);
  const questionIds = new Set(domainTopics.flatMap((topic) => topic.question_ids));
  return { primary, chapterCount: domainTopics.length, questionCount: questionIds.size };
});

const d13 = masterQuestions.find((question) => question.qid === "D13")!;
const k27 = chapters.find((chapter) => chapter.topic_id === "K27")!;

export default function HomePage() {
  return (
    <div className="dashboard">
      <section className="page-intro" aria-labelledby="page-title">
        <div className="eyebrow">LEARN · PRACTICE · EXPLAIN</div>
        <div className="intro-row">
          <div>
            <h1 id="page-title">从理解到讲清楚</h1>
            <p>把问题串成知识，把理解变成表达。</p>
          </div>
          <div className="stat-row" aria-label="资料内容数量">
            <div className="stat-chip"><FileQuestion size={17} aria-hidden="true" /><strong>{formatCount(questionMap.master_count)}</strong><span>道主练题</span></div>
            <div className="stat-chip"><Layers3 size={17} aria-hidden="true" /><strong>{formatCount(questionMap.company_question_count)}</strong><span>道企业变体</span></div>
            <div className="stat-chip"><BookOpen size={17} aria-hidden="true" /><strong>{formatCount(questionMap.topic_count)}</strong><span>个知识章节</span></div>
          </div>
        </div>
      </section>

      <section className="home-feature-grid" aria-label="开始学习">
        <Card className="start-card">
          <div className="start-card-body">
            <div className="section-kicker"><span>从这里开始</span></div>
            <h2>先独立回答，再对照原理</h2>
            <p>从一题开始，写下你的思路；看完参考后，再标记哪些检查点还需要练习。</p>
            <div className="start-card-meta">
              <Badge variant="outline">K27 · {k27.title}</Badge>
              <Badge variant="subtle">{k27.exercises.length} 道章节练习</Badge>
            </div>
          </div>
          <div className="start-card-footer">
            <div className="featured-question">
              <span className="featured-question-icon"><FileQuestion size={19} aria-hidden="true" /></span>
              <span className="featured-question-copy"><small>建议先练 · {d13.qid}</small><strong>{d13.title}</strong></span>
            </div>
            <Button asChild className="button"><Link href={`/questions/${d13.qid}/`}>开始盲答</Link></Button>
          </div>
        </Card>

        <div className="right-column">
          <Card className="status-card">
            <div className="card-heading"><Sparkles size={18} aria-hidden="true" /><span>我的学习状态</span></div>
            <StudyStatusContent kind="progress" contentVersion={chapterSet.content_version} />
          </Card>
          <Card className="review-card">
            <div className="card-heading"><Clock3 size={18} aria-hidden="true" /><span>待复习</span></div>
            <StudyStatusContent kind="review" contentVersion={chapterSet.content_version} />
          </Card>
        </div>
      </section>

      <section className="lower-grid" aria-label="学习资料">
        <Card className="section-card">
          <div className="section-card-header">
            <h2 className="section-card-title"><LibraryBig size={19} aria-hidden="true" />知识地图</h2>
            <Link className="section-card-link" href="/knowledge/">浏览全部 {topics.length} 章</Link>
          </div>
          <div className="domain-grid">
            {domainSummary.map((domain) => (
              <Link className="domain-link" key={domain.primary} href={`/knowledge/?domain=${encodeURIComponent(domain.primary)}`}>
                <span className="domain-name">{domain.primary}</span>
                <span className="domain-chapters">{domain.chapterCount} 章</span>
              </Link>
            ))}
          </div>
        </Card>

        <Card className="section-card">
          <div className="section-card-header">
            <h2 className="section-card-title"><FileQuestion size={19} aria-hidden="true" />资料概览</h2>
            <Link className="section-card-link" href="/questions/">打开题库</Link>
          </div>
          <div className="practice-list">
            <div className="practice-item">
              <div className="practice-item-copy"><strong>{questionMap.master_count} 道主练题</strong><small>按知识领域、题型与优先级筛选</small></div>
              <Badge variant="secondary">主练</Badge>
            </div>
            <div className="practice-item">
              <div className="practice-item-copy"><strong>{companyQuestions.length} 道企业扩展题</strong><small>保持原始 ID，关联对应主练题</small></div>
              <Badge variant="outline">变体</Badge>
            </div>
            <div className="practice-item">
              <div className="practice-item-copy"><strong>{chapters.length} 章 · {chapters.reduce((total, chapter) => total + chapter.exercises.length, 0)} 道练习</strong><small>章节正文、示例和来源完整呈现</small></div>
              <Badge variant="subtle">知识库</Badge>
            </div>
          </div>
        </Card>
      </section>
    </div>
  );
}
