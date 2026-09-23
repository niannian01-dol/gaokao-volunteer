# 高考志愿填报查询平台

核心流程：**查询 → 结果展示 → 推荐**。三个页面，移动端优先，数据先用假数据跑通，
正式数据通过 Excel/CSV 导入 Cloudflare D1。

> **在线试玩（假数据演示）**：https://niannian01-dol.github.io/gaokao-volunteer/
> 打开后会自动进入"本地演示模式"，直接用浏览器里的假数据算，不需要后端。

> 当前 `public/data/*.json` 与 `schema/02_seed.sql` 里全部是**占位假数据**，
> 只用于验证流程，不能用于真实志愿填报。

## 快速开始（本地，无需安装任何依赖）

```bash
node dev-server.mjs           # http://127.0.0.1:8787
node dev-server.mjs --port 9000
```

只用 Node 内置模块，不需要 `npm install`。启动后打开 http://127.0.0.1:8787 。

## 三个页面

| 页面 | 文件 | 做什么 |
| --- | --- | --- |
| 查询页 | `public/index.html` | 按省份 / 年份 / 科类 / 批次 / 院校 / 专业筛选，展示数据概览与最近查询 |
| 结果页 | `public/results.html` | 展示每个院校专业的最低分、最低位次、招生计划、学费，支持排序与分页 |
| 推荐页 | `public/recommend.html` | 输入分数或位次，输出冲 / 稳 / 保三档学校（按院校聚合，附可报专业） |

移动端：底部标签栏切换页面，结果表在窄屏下自动变成卡片布局；桌面端恢复顶部导航 + 表格。

## 目录结构

```
gaokao-platform/
├─ public/                      # 静态站点（可直接托管到任意静态服务）
│  ├─ index.html                # 查询页
│  ├─ results.html              # 结果页
│  ├─ recommend.html            # 推荐页
│  ├─ assets/
│  │  ├─ core.js                # 共享核心逻辑：过滤/排序/分页/分数位次换算/冲稳保分档
│  │  ├─ app.js                 # 页面逻辑 + 接口客户端（含无后端时的本地降级）
│  │  └─ styles.css             # 移动优先样式
│  └─ data/                     # 演示数据（假数据）
│     ├─ admission.json         # 录取记录
│     ├─ score-segments.json    # 一分一段表
│     └─ meta.json              # 筛选器选项
├─ src/worker.js                # Cloudflare Worker：/api/* + 静态资源
├─ schema/
│  ├─ 01_schema.sql             # D1 建表（4 张表 + 索引）
│  ├─ 02_seed.sql               # D1 假数据（按 4 张表自动生成）
│  └─ README.md                 # 每个字段的类型与注释
├─ scripts/
│  ├─ build-data.mjs            # 重新生成假数据 + 种子 SQL
│  ├─ csv-to-sql.mjs            # Excel/CSV → D1 SQL（真实数据入库用，含一分一段）
│  ├─ verify-d1.mjs             # 不联网验证 D1 链路：查询 / 结果 / 推荐
│  └─ lib/data-model.mjs        # 假数据模型（院校库、一分一段曲线参数）
├─ samples/                     # Excel/CSV 导入模板（列名照抄即可）
├─ dev-server.mjs               # 本地零依赖服务，实现与 Worker 相同的 /api
└─ wrangler.toml                # Cloudflare 部署配置
```

## 本地先跑通 D1 链路（不用登录 Cloudflare）

```bash
node scripts/build-data.mjs       # 重新生成 public/data/*.json 与 schema/02_seed.sql（假数据）
npx wrangler d1 execute gaokao --local --file=./schema/01_schema.sql
npx wrangler d1 execute gaokao --local --file=./schema/02_seed.sql
node scripts/verify-d1.mjs        # 用本地 D1 文件跑一遍 Worker 的 /api，逐项打勾
```

`verify-d1.mjs` 会直接加载 `src/worker.js`，把 wrangler 本地 D1 的 SQLite 文件套一层接口壳，
所以线上那条「Worker 读 D1」的代码路径在本地就能验证，不需要任何账号。

## 接口约定（本地服务与 Worker 完全一致）

```
GET /api/meta                                       筛选器选项 + 数据量统计
GET /api/query?province=江苏&year=2024&subject=物理类&batch=本科批
              &university=苏州&major=计算机&sort=rank&page=1&pageSize=20
GET /api/recommend?province=江苏&year=2024&subject=物理类&batch=本科批
              &score=600   或   &rank=30000
```

关键字段：`score`（分数）与 `rank`（位次）二选一；给分数时会用该省一分一段表换算成位次再分档。

## 数据结构

D1 里一共 4 张表，完整字段说明（类型 + 注释 + 索引 + 设计取舍）见 [`schema/README.md`](./schema/README.md)。

| 表名 | 中文名 | 一行代表什么 | 关键字段 |
| --- | --- | --- | --- |
| `university` | 院校表 | 一个院校 | 名称、所在省份/城市、类型（985/211/双一流/普通）、办学性质（公办/民办） |
| `major` | 专业表 | 一个专业 | 名称、所属门类、所属大类、专业代码、学制 |
| `admission_score` | 历年录取分数表（主表） | 一个「省份+年份+科类+批次+院校+专业」 | 最低分、最低位次、招生人数（位次是 INTEGER） |
| `score_segment` | 一分一段表 | 一个「省份+年份+科类+分数」 | 分数、位次（都是 INTEGER） |

主表同时保留名称列（`university_name` / `major_name`）和外键（`university_id` / `major_id`）：
Excel 直接导入不依赖维度表，维度表补齐后按名称回填 id，之后做院校维度统计 JOIN 即可。
前端接口也会自动关联，把院校城市、层次标签、专业门类一起返回。

> 如果你手上的 Excel 列名和模板不同，只要改 `scripts/csv-to-sql.mjs` 顶部的别名映射即可。

## 用 Excel 导入真实数据

模板见 [`samples/录取数据模板.csv`](./samples/录取数据模板.csv) 和 [`samples/一分一段模板.csv`](./samples/一分一段模板.csv)，
列名照抄即可（中文列名，顺序随便，多出来的列会被忽略）。

1. Excel 里整理好表格，首行是表头，另存为「CSV UTF-8」或直接「CSV（逗号分隔）」（脚本会自动识别 GBK）。
2. 生成 SQL：

   ```bash
   node scripts/csv-to-sql.mjs 录取数据.csv --json     # 默认整表替换，输出 schema/03_import.sql
   node scripts/csv-to-sql.mjs 一分一段.csv --segments # 输出 schema/04_segments.sql
   ```

   - `--json` 顺便刷新 `public/data/admission.json`，让本地演示模式也用上真实数据。
   - `--append` 改成追加导入（不清空原表），适合按省份、按年份分批导。
   - 录取数据脚本会自动补齐 `university` / `major` 两张维度表（`INSERT OR IGNORE`，不覆盖你手工维护过的行），
     再按名称回填 `university_id` / `major_id`，所以 Excel 里没有院校代码、门类这些列也能先跑起来。
3. 建库并导入 D1（本地演练把 `--remote` 换成 `--local`）：

   ```bash
   npx wrangler d1 create gaokao                 # 把返回的 database_id 填进 wrangler.toml
   npx wrangler d1 execute gaokao --remote --file=./schema/01_schema.sql
   npx wrangler d1 execute gaokao --remote --file=./schema/03_import.sql
   npx wrangler d1 execute gaokao --remote --file=./schema/04_segments.sql
   ```

一分一段表是推荐页做「分数 ↔ 位次」换算的依据；没导入时推荐页会自动退回"按分数分档"，仍然能用。

## 部署到 Cloudflare Workers + D1

```bash
npm install
npx wrangler login
npx wrangler d1 create gaokao        # 结果里的 database_id 填到 wrangler.toml
npx wrangler d1 execute gaokao --remote --file=./schema/01_schema.sql
npx wrangler d1 execute gaokao --remote --file=./schema/02_seed.sql   # 想用假数据先看效果就执行这句
npx wrangler deploy
```

部署前想确认 D1 里的数据能被接口正确读到，可以本地先跑 `node scripts/verify-d1.mjs`。

`wrangler.toml` 里已经配好 `[assets] directory = "./public"`，静态页面和 `/api/*` 同域，前端不需要改任何地址。

## 冲稳保分档口径

代码在 `public/assets/core.js`，改阈值只改这一处（前端、本地服务、Worker 共用）：

```js
export const RANK_RULES = { reachFloor: -0.3, reachMax: -0.08, steadyMax: 0.12, safetyCeil: 0.45, minDenominator: 500 };
export const SCORE_RULES = { reachFloor: -20, steadyMax: 12, safetyCeil: 30 };
```

位次法：`gap = (该专业往年最低位次 − 你的位次) ÷ max(你的位次, 500)`

- `-30% ≤ gap ≤ -8%` → 冲（往年录取位次比你靠前 8%~30%）
- `-8% < gap ≤ 12%` → 稳
- `12% < gap ≤ 45%` → 保

超出范围的不列出：差太远冲不上，或过于保守浪费志愿名额。推荐候选池的位次窗口 `CANDIDATE_WINDOW` 与这两条边界保持一致。

分数法（没有一分一段表时的兜底）：与往年最低分比较，低 0～20 分为冲，高 0～12 分为稳，高出 12～30 分为保。

## 数据一致性设计

假数据用"分数反查位次"的方式生成，所以每条记录的 `min_score` 与 `min_rank` 都与该省该年的一分一段表自洽；
替换成真实数据后只要保证这两列来自官方公布值即可，推荐逻辑不用改。

## 参与贡献 / 开源

本项目采用 **MIT 许可证**（见 [LICENSE](./LICENSE)），欢迎一起做。完整的参与说明见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

- 报问题、提需求：用仓库的 Issues，模板已经准备好。
- 提代码：Fork → 从 `main` 切分支 → 提 PR。CI 会自动跑语法检查、生成数据是否同步、以及 D1 接口验证。
- 上面这些检查本地都能自己跑，**不需要 Cloudflare 账号**：

  ```bash
  node scripts/build-data.mjs
  npx wrangler d1 execute gaokao --local --file=./schema/01_schema.sql
  npx wrangler d1 execute gaokao --local --file=./schema/02_seed.sql
  node scripts/verify-d1.mjs
  ```

> **数据合规**：仓库里只有脚本生成的假数据。真实的投档线、一分一段数据来自各省教育考试院，
> 转载和再分发有版权风险，请不要提交进公开仓库；用 `node scripts/csv-to-sql.mjs` 导入到自己的 D1 就行。

---

## 还没做的

- 收藏院校、志愿表导出
- 用户登录、方案保存与分享
- 接入真实一分一段表后的线差法（现在只做了位次法与分数兜底）
- 提前批的政审/面试等特殊要求校验
