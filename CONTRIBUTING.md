# 参与贡献

谢谢愿意一起把这个平台做起来。这份文档只讲三件事：项目长什么样、怎么跑、哪些东西不要提交。

## 项目结构

一个「查询 → 结果 → 推荐」的高考志愿查询平台，**零依赖、无构建步骤**：

- `public/` —— 三个静态页面，共享逻辑在 `assets/core.js`
- `src/worker.js` —— Cloudflare Worker，提供 `/api/meta`、`/api/query`、`/api/recommend`
- `dev-server.mjs` —— 本地服务，接口与 Worker 完全一致，数据读 `public/data/*.json`
- `schema/` —— D1 建表 SQL、种子数据、逐字段说明
- `scripts/` —— 假数据生成、Excel 导入、D1 接口验证

分档规则和分数↔位次换算都写在 `public/assets/core.js`，前端、本地服务、Worker 三处共用同一份，
改规则只改这一处，不要另写一套。

## 跑起来

只要 Node 20+，**不需要 `npm install`**：

```bash
node dev-server.mjs          # http://127.0.0.1:8787
node dev-server.mjs --lan    # 手机连同一个 Wi-Fi 也能打开
```

## 提交前自检

```bash
node scripts/build-data.mjs   # 改了假数据生成逻辑就重新生成
node scripts/verify-d1.mjs    # 验证 D1 接口链路（查询 / 结果 / 推荐）
```

`verify-d1.mjs` 会自动找 wrangler 的本地 D1 文件；如果还没建，先执行：

```bash
npx wrangler d1 execute gaokao --local --file=./schema/01_schema.sql
npx wrangler d1 execute gaokao --local --file=./schema/02_seed.sql
```

这整套都不需要 Cloudflare 账号。提 PR 时 CI 会跑同样的检查，本地先过一遍能省一轮往返。

## 提改动的流程

1. Fork 仓库，从 `main` 切一个分支：`feat/xxx`、`fix/xxx`、`docs/xxx`。
2. 提交信息用「类型: 简述」，例如 `feat: 推荐页支持按院校聚合`、`fix: 修正广东历史类位次换算`。
3. PR 里说清楚改了什么、怎么验证的；涉及界面的附一张截图。
4. 一个 PR 只做一件事，方便 review。

## 数据规则（重要）

- 仓库里只放**脚本生成的假数据**。`public/data/*.json` 和 `schema/02_seed.sql` 都由
  `node scripts/build-data.mjs` 生成，改了生成逻辑要重新生成并一起提交（CI 会检查是否同步）。
- **真实录取数据不要提交进仓库。** 投档线、一分一段这些数据来自各省教育考试院，
  转载和再分发有版权与合规风险。需要真实数据时用 `scripts/csv-to-sql.mjs` 导入到你自己的 D1，
  数据留在本地或私有数据库。
- 不要提交任何账号凭据。`.wrangler/`、`.dev.vars`、`.env` 已在 `.gitignore` 里，请保持。
- 改表结构要同时更新 `schema/01_schema.sql` 和 `schema/README.md`，两处必须一致。

## 代码约定

- 只用浏览器 / Node 原生能力，不引入构建步骤和前端框架；确实需要新依赖时请在 PR 里说明理由。
- 中文注释、中文提交信息都可以；文件统一 UTF-8（见 `.editorconfig`）。
- 移动端优先：改样式先在窄屏（< 640px）下看一眼。

## 许可证

MIT，见 [LICENSE](./LICENSE)。贡献的代码默认按同一许可证发布。
