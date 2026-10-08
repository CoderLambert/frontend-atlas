# 服务端账号会话：本地配置

“账号会话”使用 Better Auth 和 SQLite，为登录账号保存会话、消息和助手运行状态。它与“AI答题教练”现有的本机 ChatGPT 登录配置分开；旧的 SIWC 配置不会自动启用 GitHub 或 Google 登录。

## 数据库

默认数据库路径是仓库根目录下的 `.local-data/coach.sqlite`。首次启动前运行：

```sh
npm run db:migrate
```

如果使用 `FRONTEND_ATLAS_DB_PATH` 指向自定义数据库，迁移和开发服务器必须使用同一个路径。对已有数据库先备份并确认目标路径，避免把聊天数据写进新建的空库。

## Better Auth 和 OAuth

在本机的 `.env.local` 中设置所需变量；该文件已被 Git 忽略，不要提交密钥：

| 变量 | 用途 |
| --- | --- |
| `BETTER_AUTH_URL` | 应用实际访问的基础地址。此处的本机示例为 `http://127.0.0.1:3000`。 |
| `BETTER_AUTH_SECRET` | Better Auth 使用的高熵应用密钥。通过本机安全方式提供和保存。 |
| `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET` | 启用 GitHub 登录所需的一对 OAuth 应用凭据。 |
| `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | 启用 Google 登录所需的一对 OAuth 应用凭据。 |

把 OAuth 应用的回调地址设为与 `BETTER_AUTH_URL` 同源：

- GitHub：`http://127.0.0.1:3000/api/auth/callback/github`
- Google：`http://127.0.0.1:3000/api/auth/callback/google`

提供方只有在 Client ID 和 Client Secret 都存在时才会显示为可用。账号会话页的状态栏会报告服务端认证和各提供方是否已配置；它不会显示密钥内容，也不会为未配置的提供方启动授权。

## 本机预览

先在同一 shell 中设置数据库路径并应用迁移，然后用本机地址启动账号会话页：

```sh
export FRONTEND_ATLAS_DB_PATH=./.local-data/coach.sqlite
npm run db:migrate
export FRONTEND_ATLAS_LOCAL_MODE=1
export NEXT_PUBLIC_FRONTEND_ATLAS_LOCAL_MODE=1
npm run dev -- --hostname 127.0.0.1 --port 3000
```

打开 `http://127.0.0.1:3000/coach/sessions/`。验证真实 OAuth 时，确保 `FRONTEND_ATLAS_MOCK_AUTH` 和 `FRONTEND_ATLAS_MOCK_ASSISTANT` 没有设为 `1`。若认证地址、认证密钥或提供方凭据缺失，页面会如实显示未配置状态。

目前没有配置真实助手服务提供方。助手状态显示“未连接”时，服务端不会生成真实模型回复；本地 Mock 只用于明确标记的测试或演示。
