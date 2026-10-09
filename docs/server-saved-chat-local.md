# 服务端账号会话：本地配置

“账号会话”使用 Better Auth 和 SQLite，为登录账号保存会话、消息、真实 ChatGPT 流式回复和助手运行状态。站点 OAuth 与本机 ChatGPT（SIWC）仍是两套独立身份；任何现有 SIWC profile 都不会自动分配给站点用户。

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

## 启动完整本机链路

先确认数据库路径。对已有数据库做 SQLite 一致性备份并检查迁移内容后，在同一 shell 中应用迁移：

```sh
export FRONTEND_ATLAS_DB_PATH=./.local-data/coach.sqlite
npm run db:migrate
npm run local:dev
```

`local:dev` 会同时启动 `127.0.0.1:3000` 的 Next.js 与 `127.0.0.1:4317` 的 SIWC 服务；缺少任一服务都不算真实助手可用。它会为本次进程生成不写盘、不打印的服务间凭据，4317 的 profile、模型和助手内部接口都会核验该凭据。不要用单独的 `npm run dev` 验收真实 ChatGPT 链路。

打开 `http://127.0.0.1:3000/coach/sessions/`。验证真实 OAuth 时，确保 `FRONTEND_ATLAS_MOCK_AUTH` 和 `FRONTEND_ATLAS_MOCK_ASSISTANT` 没有设为 `1`。Mock 助手默认关闭；只有显式执行 `FRONTEND_ATLAS_MOCK_ASSISTANT=1 npm run local:dev` 才会启用带明显标记的测试回复。

## 受控分配 ChatGPT 连接

可信本机操作者可以查看站点用户和本机 SIWC profile 的非密钥元数据：

```sh
npm run provider:bindings -- list
```

核对 Better Auth 用户与可恢复、具有计划用量权限的 SIWC profile 后，显式创建一对一分配：

```sh
npm run provider:bindings -- assign --user <better-auth-user-id> --profile <siwc-client-id>
```

该命令不会创建、复制或打印 token。站点页面不会列出本机 profile，也不接受用户提交 profileId 自助认领。4317 重启后，已分配用户可以在页面点击“恢复已授权连接”；服务端只会恢复数据库中分配的 profile。解除分配会取消使用旧绑定版本的进行中运行，但不会删除 SQLite 历史或本机 SIWC 凭据。

恢复后，用户只能从该账号实时返回的可用模型中选择。每次助手运行都会重新核验 Better Auth session 的 userId、分配、绑定版本、SIWC session、计划权限和模型；浏览器不会接收 provider token，也不能指定代理地址。

真实回复沿用同一套 SQLite run 管理器：用户消息与运行先原子保存，流式偏移可恢复，重复 `clientRunId` 不重复调用上游，取消、异常 EOF 和连接错误保留已落库的尾段并标记真实状态。刷新或重启后从 `/coach/sessions/` 恢复；旧 `/coach/` 的 IndexedDB 对话只会在用户预览并再次确认后导入，导入不会删除浏览器原记录。
