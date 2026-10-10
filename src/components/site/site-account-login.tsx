"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, LoaderCircle, LogIn, LogOut } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { SocialProvider } from "@/lib/account-link-state";

type AccountSnapshot = {
  authConfigured: boolean;
  providers: Record<SocialProvider, boolean>;
  account: { id: string; name: string; email: string } | null;
};

const labels: Record<SocialProvider, string> = { github: "GitHub", google: "Google" };

export function SiteAccountLogin() {
  const [snapshot, setSnapshot] = useState<AccountSnapshot | null>(null);
  const [busy, setBusy] = useState<SocialProvider | "sign-out" | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/site-account", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 503 ? "此功能只在服务端部署中可用。" : "无法读取知序站点账号状态。");
      setSnapshot(await response.json() as AccountSnapshot);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取知序站点账号状态。");
    }
  }, []);

  useEffect(() => {
    let active = true;
    void fetch("/api/site-account", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 503 ? "此功能只在服务端部署中可用。" : "无法读取知序站点账号状态。");
        return await response.json() as AccountSnapshot;
      })
      .then((value) => { if (active) setSnapshot(value); })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "无法读取知序站点账号状态。");
      });
    return () => { active = false; };
  }, []);

  async function signIn(provider: SocialProvider) {
    if (!snapshot?.providers[provider] || busy) return;
    setBusy(provider);
    setError("");
    try {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-frontend-atlas-request": "1" },
        body: JSON.stringify({ provider, callbackURL: "/account/", errorCallbackURL: "/account/", disableRedirect: true }),
      });
      const result = await response.json() as { url?: string; error?: string };
      if (!response.ok || !result.url) throw new Error(result.error ?? "认证服务没有返回授权地址。");
      window.location.assign(result.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "认证请求失败。");
      setBusy(null);
    }
  }

  async function signOut() {
    if (busy) return;
    const expectedAccountId = snapshot?.account?.id;
    if (!expectedAccountId) return;
    setBusy("sign-out");
    setError("");
    try {
      const response = await fetch("/api/auth/sign-out", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-frontend-atlas-request": "1",
          "x-frontend-atlas-account-id": expectedAccountId,
        },
        body: "{}",
      });
      if (response.status === 409) {
        await load();
        throw new Error("账号状态已变化，已重新读取当前登录状态。");
      }
      if (!response.ok) throw new Error("退出登录没有完成。");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "退出登录失败。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="coach-account-page" data-testid="hosted-site-account">
      <Card className="coach-account-login-card">
        <CardHeader>
          <CardTitle><LogIn size={18} aria-hidden="true" />知序站点账号</CardTitle>
          <p>站点登录用于跨设备保存私人题目版本；它不会连接 ChatGPT/SIWC 或授权模型用量。</p>
        </CardHeader>
        <CardContent>
          {!snapshot && !error && <p className="coach-account-loading"><LoaderCircle className="animate-spin" aria-hidden="true" />正在读取站点账号…</p>}
          {error && <p className="coach-account-inline-error" role="alert"><AlertCircle size={15} aria-hidden="true" />{error}</p>}
          {snapshot?.account ? (
            <div className="coach-account-signed-in">
              <p data-testid="hosted-account-email">已登录：{snapshot.account.email}</p>
              <Button variant="outline" onClick={() => void signOut()} disabled={busy !== null} data-testid="hosted-account-sign-out">
                {busy === "sign-out" ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <LogOut size={15} aria-hidden="true" />}退出登录
              </Button>
            </div>
          ) : snapshot ? (
            <div className="coach-account-provider-grid">
              {(["github", "google"] as const).map((provider) => (
                <div key={provider} className="coach-account-provider-row">
                  <div><strong>{labels[provider]}</strong><span>{snapshot.providers[provider] ? "已配置，可连接" : "尚未配置"}</span></div>
                  {snapshot.providers[provider]
                    ? <Button onClick={() => void signIn(provider)} disabled={busy !== null} data-testid={`hosted-sign-in-${provider}`}>
                      {busy === provider ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <LogIn size={15} aria-hidden="true" />}使用 {labels[provider]} 登录
                    </Button>
                    : <Badge variant="outline">未启用</Badge>}
                </div>
              ))}
              {!snapshot.authConfigured && <p className="coach-account-setup-note">站点 OAuth 尚未就绪。请在部署环境配置站点认证地址、密钥和 OAuth 提供方凭据。</p>}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
