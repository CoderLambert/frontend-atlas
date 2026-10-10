import Link from "next/link";
import { Suspense } from "react";
import { ArrowUpRight, CheckCircle2, CircleHelp, Laptop, ShieldCheck, WandSparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AiAssistQuestionContext } from "@/components/site/ai-assist-question-context";
import { CopyCommandsButton } from "@/components/site/copy-commands-button";
import { questionIndex } from "@/lib/content";

export const metadata = { title: "AI 辅助练习" };

const repositoryUrl = "https://github.com/CoderLambert/frontend-atlas";
const setupCommands = "git clone https://github.com/CoderLambert/frontend-atlas.git\ncd frontend-atlas\nnpm ci\nnpm run local:dev";
const updateCommands = "git pull --ff-only\nnpm ci\nnpm run local:dev";

export default function AiAssistPage() {
  if (process.env.NEXT_PUBLIC_FRONTEND_ATLAS_DEPLOYMENT_MODE === "hosted") {
    return (
      <div className="assist-guide-page">
        <section className="page-intro" aria-labelledby="assist-title">
          <div className="eyebrow">OPTIONAL · AI INTEGRATION</div>
          <div className="intro-row">
            <div>
              <h1 id="assist-title">AI 辅助练习</h1>
              <p>当前 Docker 部署提供题库、学习进度和站点账号功能；ChatGPT/SIWC 本机授权不会随镜像迁移。</p>
            </div>
            <Badge variant="outline">站点已部署 · AI 未连接</Badge>
          </div>
        </section>
        <Card className="assist-static-notice">
          <CardContent>
            <div className="assist-notice-icon"><ShieldCheck size={20} aria-hidden="true" /></div>
            <div>
              <strong>此部署不提供远程 ChatGPT 账号连接</strong>
              <p>此部署已关闭 AI 教练入口和 SIWC 服务；本机回环 OAuth 回调不能指向公开域名，站点镜像也不会带入任何 ChatGPT 会话。OpenAI 为用户独占的自托管 VM 文档化了本地授权后安全转移受保护凭据的流程，但本部署没有实现或验证这条独立链路。请勿把令牌放进镜像、部署环境变量或共享服务。</p>
              <p>Git 审核与发布操作也只能在独立的受信任 operator checkout 中进行，Web 容器不包含 Git 仓库或发布权限。</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }
  return (
    <div className="assist-guide-page">
      <section className="page-intro" aria-labelledby="assist-title">
        <div className="eyebrow">OPTIONAL · LOCAL CHATGPT COACH</div>
        <div className="intro-row">
          <div>
            <h1 id="assist-title">AI 辅助练习</h1>
            <p>学习站上的这页是说明。要看到 ChatGPT 登录入口，请在自己的电脑运行本机版。</p>
          </div>
          <Badge variant="outline">本机功能 · 真实账号待验收</Badge>
        </div>
      </section>

      <Suspense fallback={null}>
        <AiAssistQuestionContext questionIds={questionIndex.map((question) => question.qid)} />
      </Suspense>

      <Card className="assist-static-notice">
        <CardContent>
          <div className="assist-notice-icon"><Laptop size={20} aria-hidden="true" /></div>
          <div>
            <strong>为什么当前页面没有 ChatGPT 登录按钮？</strong>
          <p>此网址是静态学习站，不接收账号授权，也不连接模型。登录和教练只在本机 Node 服务启动后出现；当前本机版未提供手机直接运行方案。</p>
          </div>
        </CardContent>
      </Card>

      <div className="assist-guide-grid">
        <Card className="assist-setup-card">
          <CardHeader className="assist-card-header">
            <div>
              <CardTitle><Laptop size={19} aria-hidden="true" />在电脑上启动</CardTitle>
              <p>需要 Node.js 24、npm、Git，以及此私有 GitHub 仓库的访问权限。</p>
            </div>
              <Badge variant="subtle">首次启动</Badge>
          </CardHeader>
          <CardContent className="assist-setup-content">
            <ol className="assist-steps">
              <li><strong>打开终端</strong><span>Windows PowerShell、macOS 终端或 Linux shell 均可。</span></li>
              <li><strong>复制并运行命令</strong><span>首次安装依赖可能需要一些时间。</span></li>
              <li><strong>打开本机页面</strong><span>在同一台电脑的浏览器访问 <code>http://127.0.0.1:3000/coach/</code>。</span></li>
            </ol>
            <div className="assist-command-block">
              <pre><code>{setupCommands}</code></pre>
              <CopyCommandsButton value={setupCommands} />
            </div>
            <p className="assist-command-note">本机服务只监听 127.0.0.1。关闭终端中的服务后，教练页面就无法使用。</p>
            <section className="assist-existing-update" aria-labelledby="assist-update-title">
              <h3 id="assist-update-title">后续更新已有副本</h3>
              <p>先在项目目录单独运行 <code>git status --short</code>。如果有输出，先手动保存或备份本地改动，确认安全后再继续；不要直接覆盖未提交文件。</p>
              <p>确认工作区干净后，再运行以下命令：</p>
              <div className="assist-command-block">
                <pre><code>{updateCommands}</code></pre>
                <CopyCommandsButton value={updateCommands} />
              </div>
              <p className="assist-command-note">git pull --ff-only 只接受可快进的更新；若分支有分叉，它会停止而不自动合并。</p>
            </section>
            <Button asChild variant="outline" className="assist-repo-link">
              <Link href={repositoryUrl + "#readme"} target="_blank" rel="noreferrer">打开私有 GitHub README <ArrowUpRight size={15} aria-hidden="true" /></Link>
            </Button>
          </CardContent>
        </Card>

        <div className="assist-side-column">
          <Card className="assist-capabilities-card">
            <CardHeader className="assist-card-header">
              <div><CardTitle><WandSparkles size={19} aria-hidden="true" />本机教练能做什么</CardTitle><p>先自己作答，再使用模型建议辅助学习。</p></div>
            </CardHeader>
            <CardContent className="assist-list-content">
              <ul>
                <li>选择题库中的题目，先写下自己的回答。</li>
                <li>选择获取一条提示、讲解核心原理，或按参考内容点评。</li>
                <li>登录后读取账号实际可用的 ChatGPT 模型；是否有计划用量权限以账号状态为准。</li>
                <li>建议不打分、不代替自评，也不代表招聘结论。</li>
              </ul>
            </CardContent>
          </Card>

          <Card className="assist-status-card">
            <CardHeader className="assist-card-header">
              <div><CardTitle><ShieldCheck size={19} aria-hidden="true" />当前验证状态</CardTitle><p>把已验证和待验证的部分分开说明。</p></div>
            </CardHeader>
            <CardContent className="assist-list-content">
              <p className="assist-status-pass"><CheckCircle2 size={16} aria-hidden="true" /><span>本地 mock 协议与接口检查通过。</span></p>
              <p className="assist-status-pending"><CircleHelp size={16} aria-hidden="true" /><span>真实 ChatGPT 账号登录、订阅用量授权与模型请求尚未实测。</span></p>
              <p className="assist-privacy-note">在生成请求之前不会发送练习回答。点击发送后，本题、参考内容和回答会提交到 OpenAI 生成反馈；草稿留在本机浏览器数据中。</p>
            </CardContent>
          </Card>
        </div>
      </div>
      <p className="assist-return-link"><Link href="/questions/">回到题库</Link><span aria-hidden="true">·</span><Link href="/">返回学习台</Link></p>
    </div>
  );
}
