# 知序 · 前端面试学习站

面向个人复习的 Next.js App Router 学习站。默认构建仍是静态学习站；可选的 AI 答题教练只在本地运行配置中启用。资料保留原题 ID、章节映射和来源信息。普通学习记录和旧版 `/coach/` 对话保存在当前浏览器的 IndexedDB；登录后的 `/coach/sessions/` 会话、消息和助手运行按站点用户保存在本机 SQLite。

## Docker 部署

需要在其他机器运行站点时，使用可配置域名、Caddy HTTPS、持久化 SQLite 和安全备份/恢复入口：

```sh
./deploy.sh
```

首次运行会询问本地测试或 HTTPS 域名部署，并安全输入 Better Auth/OAuth 配置。部署只迁移站点；本机 ChatGPT/SIWC 会话不会复制或启用。完整要求、OAuth 回调、数据恢复和 operator 权限边界见 [Docker 部署说明](./docs/docker-deployment.md)。

## 内容范围

- 214 道主练题（含 3 道 React 学习试点新增题）
- 47 道企业问法变体，作为扩展练习单独标示，不计入主练题数量
- 35 个知识章节，包含完整正文、示例、边界与 70 道章节练习
- D13 映射至 K27；K12 保留原有的“页面生命周期与调度”标题

题目检索和章节索引由 `src/content/*source.json` 在构建时生成。默认静态站不调用 AI、评分 API 或分析服务，也不会执行用户输入的代码。

React 试点增强 F01、F04、F17，并新增 F31–F33；六题均关联既有 K18。未新增企业变体、章节或章节练习。内容版本已更新为 `2026-10-04.2`，旧设备记录与备份仍保留原内容版本。

## 本地运行

需要 Node.js 24 和 npm。

```sh
npm ci
npm run dev
```

如需启用服务端账号聊天和真实 ChatGPT 回复，请按[本地账号会话配置说明](./docs/server-saved-chat-local.md)准备 SQLite 数据库、OAuth 提供方和受控 SIWC profile 分配。

默认开发命令只运行学习站。若要试用本机 AI 答题教练，请使用单独的本地运行配置：

```sh
npm run local:dev
```

然后打开 `http://127.0.0.1:3000`。本机 Next.js 页面和 Node 服务分别只绑定 `127.0.0.1:3000` 与 `127.0.0.1:4317`；若端口被占用，启动会停止，不会改用网络接口或自动换端口。旧版“AI答题教练”仍把对话保存在 IndexedDB；“账号会话”会在可信操作者把本机 SIWC profile 分配给站点用户后，将真实回复写入该用户的 SQLite 会话。两项功能都通过 SIWC 读取账号当前可用模型，请求使用 Responses API 的 `store: false` 与流式响应，不自动切换到 API Key 计费。

若要使用本机 production preview，可运行 `npm run local:build`，再运行 `npm run local:start`。`local:build` 使用 Node 服务支持的 Next.js 构建配置，不是 Sites 静态发布包。

访问令牌保存在本机用户配置目录 `~/.config/frontend-atlas/siwc-profiles.json`，不放进浏览器、仓库或备份。Unix 系统使用仅当前用户可访问的 `0700` 目录和 `0600` 文件；Windows 使用当前用户配置目录的默认访问控制。该文件不做应用层加密，请保护好当前操作系统账号。应用会尝试在退出时撤销续期会话并清除本机令牌；如果本机清除失败，会保留一个“待清理”状态，不能继续使用该账号，并可从教练页重试。

此集成面向本地开源应用。默认 `npm run build` 仍会静态导出到 `out/`；`/coach` 在静态导出中应为 404。静态构建不会包含 OAuth 端点、授权范围或本地凭据路径。不要用 `npm run local:build` 的产物替代 Sites 的静态发布产物。

常用检查：

```sh
npm run lint
npm run typecheck
npm run test:backup
npm run test:siwc
npm run test:provider-connection
npm run test:assistant-run
npm run build
npm run verify:static-boundary
```

`npm run test:siwc` 使用本地 mock 响应、临时目录和测试签名密钥，不创建 OpenAI OAuth 授权，也不发送模型请求。`npm run build` 会校验内容清单并执行 Next.js 静态导出，结果写入 `out/`；`npm run verify:static-boundary` 检查静态产物中没有本地 SIWC 服务/凭据材料，并确认 `/coach` 仍是 404。**真实账号登录和模型调用没有纳入 mock 测试。**

本机人工验收清单：

- 首次点击登录、取消授权、登录页关闭后重试；确认没有状态串用。
- 首次注册的临时代码过期后，确认可以用已保存的 OpenAI 客户端 ID继续完成，不会重复注册。
- 在多个 ChatGPT 账号之间切换；取消计划用量授权后，不应请求模型或切换到其他计费方式。
- 提示、讲解、点评三种模式都能工作；停止生成、网络错误、用量限制和未完整结束的响应会清楚显示。
- 退出时确认远端撤销结果；如果本机凭据无法清除，重试清理并确认账号不可继续使用。
- 在桌面与窄屏视口检查键盘导航、焦点、草稿恢复、题目切换和错误提示。

静态学习记录与旧版本地教练对话保存在浏览器的 IndexedDB 中，不会自动同步到账号。换浏览器或清理站点数据前，请在“本设备数据”页导出 JSON 备份并妥善保管；新版备份包含旧版 AI 对话，并兼容导入旧版备份。登录后的账号会话另存于本机 SQLite；旧记录必须在账号会话页预览并确认后才会导入，原 IndexedDB 记录不会自动上传或删除。
