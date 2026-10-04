import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { chapterById, chapterSet, chapters, topicById, topicIndex } from "@/lib/content";

export const dynamicParams = false;

export function generateStaticParams() {
  return chapters.map((chapter) => ({ topicId: chapter.topic_id }));
}

export async function generateMetadata({ params }: { params: Promise<{ topicId: string }> }): Promise<Metadata> {
  const { topicId } = await params;
  const chapter = chapterById(topicId);
  return chapter ? { title: chapter.topic_id + " · " + chapter.title } : { title: "知识章节未找到" };
}

function safeHttpsUrl(url: unknown) {
  if (typeof url !== "string") return null;
  try {
    const safe = new URL(url);
    return safe.protocol === "https:" ? safe.href : null;
  } catch {
    return null;
  }
}

function SafeSourceLink({ url, children }: { url?: unknown; children: React.ReactNode }) {
  const href = safeHttpsUrl(url);
  return href ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <>{children}</>;
}

function NoteList({ notes }: { notes: Array<string | { title: string; text: string }> }) {
  return (
    <ul className="chapter-note-list">
      {notes.map((note, index) => {
        const title = typeof note === "string" ? "" : note.title;
        const text = typeof note === "string" ? note : note.text;
        return <li key={index}>{title && <strong>{title} · </strong>}{text}</li>;
      })}
    </ul>
  );
}

export default async function KnowledgeChapterPage({ params }: { params: Promise<{ topicId: string }> }) {
  const { topicId } = await params;
  const chapter = chapterById(topicId);
  const topic = topicById(topicId);
  const indexed = topicIndex.find((item) => item.topicId === topicId.toUpperCase());
  if (!chapter || !topic || !indexed) notFound();

  return (
    <article className="chapter-page">
      <div className="question-breadcrumb"><Link href="/knowledge/">知识库</Link><span aria-hidden="true">/</span><span>{chapter.topic_id}</span></div>
      <header className="chapter-header">
        <div className="eyebrow">{topic.primary.toUpperCase()} · KNOWLEDGE CHAPTER</div>
        <div className="chapter-title-row"><Badge variant="outline">{chapter.topic_id}</Badge><h1>{chapter.title}</h1></div>
        <p>{chapter.mental_model}</p>
        <div className="chapter-tags"><Badge variant="secondary">{topic.primary}</Badge><Badge variant="subtle">{chapter.exercises.length} 道章节练习</Badge><Badge variant="outline">{chapter.question_ids.length} 道主练关联</Badge></div>
        <div className="chapter-prerequisites"><span>先修知识：</span>{chapter.prerequisites.length ? chapter.prerequisites.map((id) => {
          const prior = chapterById(id);
          return <Link key={id} href={"/knowledge/" + id + "/"}>{id}{prior ? " · " + prior.title : ""}</Link>;
        }) : <span>无</span>}</div>
      </header>

      <div className="chapter-layout">
        <nav className="chapter-toc" aria-label="本章目录">
          <strong>本章目录</strong>
          <a href="#core-model">核心模型</a>
          {chapter.mechanisms.map((section, index) => <a key={index} href={"#mechanism-" + String(index + 1)}>{section.title}</a>)}
          <a href="#example">最小示例</a>
          <a href="#boundaries">边界与取舍</a>
          <a href="#oral-summary">口述示范</a>
          <a href="#chapter-exercises">章节练习</a>
          <a href="#related-questions">关联题目</a>
          <a href="#sources">参考来源</a>
        </nav>

        <div className="chapter-content">
          <section className="chapter-section" id="core-model">
            <h2>核心模型</h2>
            <p className="chapter-model">{chapter.mental_model}</p>
          </section>

          <section className="chapter-section" aria-labelledby="mechanisms-title">
            <h2 id="mechanisms-title">原理与机制</h2>
            <div className="mechanism-list">
              {chapter.mechanisms.map((section, index) => (
                <section className="mechanism-section" id={"mechanism-" + String(index + 1)} key={index}>
                  <h3>{section.title}</h3>
                  <p>{section.text}</p>
                </section>
              ))}
            </div>
          </section>

          <section className="chapter-section" id="example">
            <h2>最小示例</h2>
            {chapter.example.language && <Badge variant="outline">{chapter.example.language}</Badge>}
            <pre className="code-block chapter-code"><code>{chapter.example.code}</code></pre>
            <p>{chapter.example.explanation}</p>
            {chapter.example.environment && <p className="source-note">环境：{chapter.example.environment}</p>}
            {chapter.example.verification && <p className="source-note">核验：{chapter.example.verification}</p>}
          </section>

          <section className="chapter-section boundaries-section" id="boundaries">
            <h2>边界与取舍</h2>
            <div><h3>边界</h3><NoteList notes={chapter.boundaries} /></div>
            <div><h3>取舍</h3><NoteList notes={chapter.tradeoffs} /></div>
          </section>

          <section className="chapter-section oral-summary-section" id="oral-summary">
            <h2>口述示范</h2>
            <p>{chapter.oral_summary}</p>
          </section>

          <section className="chapter-section" id="chapter-exercises">
            <h2>章节练习</h2>
            <div className="exercise-list">
              {chapter.exercises.map((exercise, index) => (
                <Card className="exercise-card" key={index}>
                  <div className="exercise-kicker">练习 {index + 1}</div>
                  <h3>{exercise.prompt}</h3>
                  <details><summary>展开检查点</summary><ul>{exercise.checkpoints.map((point, pointIndex) => <li key={pointIndex}>{point}</li>)}</ul></details>
                  <div className="exercise-question-links"><span>相关题目：</span>{exercise.question_ids.map((id) => <Link key={id} href={"/questions/" + id + "/"}>{id}</Link>)}</div>
                </Card>
              ))}
            </div>
          </section>

          <section className="chapter-section" id="related-questions">
            <div className="section-card-header"><h2>关联题目</h2><Link className="section-card-link" href={"/questions/?topic=" + chapter.topic_id}>在题库中筛选本章</Link></div>
            <div className="chapter-question-grid">
              {chapter.question_ids.map((id) => {
                const question = topic.question_ids.includes(id) ? id : null;
                if (!question) return null;
                return <Link className="chapter-question-link" key={id} href={"/questions/" + id + "/"}><strong>{id}</strong><span>{chapter.question_references.find((reference) => reference.qid === id)?.title ?? "打开关联题"}</span></Link>;
              })}
              {chapter.company_references.map((reference) => (
                <Link className="chapter-question-link company-reference" key={reference.qid} href={"/questions/" + reference.qid + "/"}>
                  <strong>{reference.qid}</strong><span>{reference.company} · {reference.title}</span><Badge variant="subtle">扩展问法</Badge>
                </Link>
              ))}
            </div>
          </section>

          <section className="chapter-section" id="sources">
            <h2>参考来源与核验边界</h2>
            <ul className="source-list">
              {chapter.sources.map((source, index) => {
                const title = typeof source.title === "string" ? source.title : "资料 " + String(index + 1);
                const verified = typeof source.verified_date === "string" ? source.verified_date : null;
                const limitation = typeof source.limitations === "string" ? source.limitations : null;
                return <li key={index}><SafeSourceLink url={source.url}>{title}</SafeSourceLink>{verified && <span> · 核验 {verified}</span>}{limitation && <p>{limitation}</p>}</li>;
              })}
            </ul>
            <p className="version-note">{chapter.version_notes}</p>
            <p className="content-source-note">内容版本：{chapterSet.content_version} · 题目和来源 ID 保持原样，本站不将面经标签解释为企业官方出题或高频保证。</p>
          </section>
        </div>
      </div>
    </article>
  );
}
