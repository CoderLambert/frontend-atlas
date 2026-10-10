import { SiteAccountLogin } from "@/components/site/site-account-login";

export const metadata = { title: "知序站点账号" };

export default function AccountPage() {
  return (
    <div className="assist-guide-page">
      <section className="page-intro" aria-labelledby="account-title">
        <div className="eyebrow">SITE ACCOUNT</div>
        <div className="intro-row"><div><h1 id="account-title">知序站点账号</h1><p>管理本站身份，用于保存私人题目版本。</p></div></div>
      </section>
      <SiteAccountLogin />
    </div>
  );
}
