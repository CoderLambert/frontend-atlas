import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Card } from "@/components/ui/card";

export default function Forbidden() {
  return (
    <Card className="reviewer-forbidden" role="region" aria-labelledby="reviewer-forbidden-title">
      <ShieldAlert aria-hidden="true" />
      <div>
        <h1 id="reviewer-forbidden-title">没有题库审核权限</h1>
        <p>审核权限只能由本机管理员按 Better Auth userId 显式授予。登录、邮箱或 OAuth 提供方不会自动获得权限。</p>
        <Link href="/">返回学习台</Link>
      </div>
    </Card>
  );
}
