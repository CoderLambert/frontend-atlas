# 知序 · 前端面试学习站

面向个人复习的静态 Next.js App Router 学习站。资料保留原题 ID、章节映射和来源信息；写下的回答、自评与复习安排只保存在当前浏览器的 IndexedDB 中。

## 内容范围

- 211 道主练题
- 47 道企业问法变体，作为扩展练习单独标示，不计入主练题数量
- 35 个知识章节，包含完整正文、示例、边界与 70 道章节练习
- D13 映射至 K27；K12 保留原有的“页面生命周期与调度”标题

题目检索和章节索引由 `src/content/*source.json` 在构建时生成；网站不会调用 AI、后端评分 API、分析服务，也不会执行用户输入的代码。

## 本地运行

需要 Node.js 24 和 npm。

```sh
npm ci
npm run dev
```

常用检查：

```sh
npm run lint
npm run typecheck
npm run test:backup
npm run build
```

`npm run build` 会校验内容清单并执行 Next.js 静态导出，结果写入 `out/`。本地练习数据不会随导出文件上传；请在“本设备数据”页导出 JSON 备份，换浏览器或清理站点数据前先下载并保管。
