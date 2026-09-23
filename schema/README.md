# 数据库表结构说明（Cloudflare D1 / SQLite）

建表脚本：[`01_schema.sql`](./01_schema.sql)

> D1 基于 SQLite，**SQLite 不支持 `COMMENT ON COLUMN` 语法**。
> 所以字段注释用两种方式表达：SQL 文件里写在字段后的行内 `-- 注释`，以及下面的字段说明表。
> 建表语句全部是 `CREATE TABLE IF NOT EXISTS`，可以重复执行，不会清空已有数据。

四张表、一句话职责：

| 表名 | 中文名 | 一行代表什么 |
| --- | --- | --- |
| `university` | 院校表 | 一个院校 |
| `major` | 专业表 | 一个专业（专业目录维度） |
| `admission_score` | 历年录取分数表 | 一个「省份+年份+科类+批次+院校+专业」的录取结果 |
| `score_segment` | 一分一段表 | 一个「省份+年份+科类+分数」的位次档位 |

---

## 1. `university` 院校表

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | INTEGER | PK 自增 | 主键 |
| `university_code` | TEXT | NOT NULL，唯一 | 院校代码（教育部统一代码），Excel 导入的匹配键 |
| `name` | TEXT | NOT NULL，唯一 | 院校名称，如「清华大学」 |
| `province` | TEXT | NOT NULL | 所在省份，如「江苏」 |
| `city` | TEXT | | 所在城市，如「南京」 |
| `type` | TEXT | NOT NULL，默认 `普通` | 院校类型：`985` / `211` / `双一流` / `普通`（取最高层次） |
| `nature` | TEXT | NOT NULL，默认 `公办` | 办学性质：`公办` / `民办` |
| `tags` | TEXT | | 层次标签，逗号分隔可多值，如 `985,211,双一流` |
| `created_at` | INTEGER | NOT NULL，默认 `unixepoch()` | 创建时间（Unix 秒） |
| `updated_at` | INTEGER | NOT NULL，默认 `unixepoch()` | 更新时间（Unix 秒） |

> 一个院校同时是 985 和 211 时：`type` 填最高层次（`985`），`tags` 填 `985,211`，两个都能查。

## 2. `major` 专业表

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | INTEGER | PK 自增 | 主键 |
| `major_code` | TEXT | NOT NULL，唯一 | 专业代码（教育部专业目录），如 `080901` |
| `name` | TEXT | NOT NULL | 专业名称，如「计算机科学与技术」 |
| `category` | TEXT | NOT NULL | 所属门类，如「工学」 |
| `sub_category` | TEXT | | 所属大类（专业类），如「计算机类」 |
| `degree` | TEXT | | 授予学位门类，如「工学学士」 |
| `duration` | INTEGER | | 标准学制（年），如 4 |
| `created_at` / `updated_at` | INTEGER | NOT NULL | 创建 / 更新时间（Unix 秒） |

> 门类指 12 个学科门类（哲学、经济学、法学、教育学、文学、历史学、理学、工学、农学、医学、管理学、艺术学）；大类指其下的专业类。

## 3. `admission_score` 历年录取分数表（主表）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | INTEGER | PK 自增 | 主键 |
| `province` | TEXT | NOT NULL | 招生省份（考生所在省），如「江苏」 |
| `year` | INTEGER | NOT NULL | 录取年份，如 2024 |
| `subject_category` | TEXT | NOT NULL | 科类：`文科` / `理科` / `物理类` / `历史类` / `综合` |
| `batch` | TEXT | NOT NULL | 批次：`提前批` / `本科批` / `专科批` |
| `university_code` | TEXT | | 院校代码（冗余，便于和 Excel 对齐） |
| `university_name` | TEXT | NOT NULL | 院校名称 |
| `university_id` | INTEGER | FK → `university.id` | 关联院校维度表，未匹配到时为 NULL |
| `major_code` | TEXT | | 专业代码（冗余） |
| `major_name` | TEXT | NOT NULL | 专业名称 |
| `major_id` | INTEGER | FK → `major.id` | 关联专业维度表，未匹配到时为 NULL |
| `min_score` | INTEGER | | 最低分 |
| `min_rank` | INTEGER | | **最低位次（整数）**，冲稳保分档的核心字段 |
| `plan_count` | INTEGER | | 招生人数（招生计划数） |
| `created_at` / `updated_at` | INTEGER | NOT NULL | 创建 / 更新时间（Unix 秒） |

**唯一键** `ux_admission_key(province, year, subject_category, batch, university_name, major_name)`
→ 同一省份/年份/科类/批次下，同一院校同一专业只允许一条记录，Excel 重复导入时可以用 `ON CONFLICT DO UPDATE` 覆盖，不会出现重复行。

## 4. `score_segment` 一分一段表

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | INTEGER | PK 自增 | 主键 |
| `province` | TEXT | NOT NULL | 省份，如「江苏」 |
| `year` | INTEGER | NOT NULL | 年份，如 2024 |
| `subject_category` | TEXT | NOT NULL | 科类：`文科` / `理科` / `物理类` / `历史类` / `综合` |
| `score` | INTEGER | NOT NULL，CHECK 0–750 | 分数 |
| `rank` | INTEGER | NOT NULL，CHECK > 0 | **该分数对应的位次（整数）**，即累计位次 |
| `count` | INTEGER | | 本分数段人数（可选，部分省份不公布） |
| `cumulative_count` | INTEGER | | 累计人数（可选，该分数及以上总人数） |
| `created_at` / `updated_at` | INTEGER | NOT NULL | 创建 / 更新时间（Unix 秒） |

**唯一键** `ux_segment_key(province, year, subject_category, score)` → 同省同年同科类同分数只有一条。

---

## 索引

| 索引 | 表 | 字段 | 用途 |
| --- | --- | --- | --- |
| `ux_university_code` / `ux_university_name` | university | code / name | 唯一约束 + 精确匹配 |
| `ix_university_province` / `ix_university_type` / `ix_university_nature` | university | 单列 | 按省份、层次、办学性质筛选 |
| `ux_major_code` | major | major_code | 唯一约束 |
| `ix_major_name` / `ix_major_category` | major | name / (category, sub_category) | 按专业名、门类筛选 |
| `ux_admission_key` | admission_score | 六列联合 | 去重 / upsert 冲突目标 |
| `ix_admission_query` | admission_score | province, year, subject_category, batch, min_rank | 查询页主路径（筛选后按位次排序） |
| `ix_admission_rank` | admission_score | province, subject_category, min_rank | 推荐页按位次扫区间（冲/稳/保） |
| `ix_admission_university` / `ix_admission_major` | admission_score | 单列 | 按院校 / 专业模糊查询 |
| `ux_segment_key` / `ix_segment_rank` | score_segment | 四列联合 / (province, year, subject_category, rank) | 分数换位次、位次换分数 |

## 设计说明

1. **位次、分数、人数一律 INTEGER**，不用 TEXT，保证按位次排序和区间比较在索引上直接生效。
2. **枚举值不写 `CHECK`**（院校类型、办学性质、科类、批次）。原因是各省 Excel 里科类写法不统一（`物理` / `物理类` / `物理/化学`），
   加了 `CHECK` 会让整批导入直接失败。取值约定写在 SQL 文件末尾，导入后清洗比强行约束更实用。
   只有 `score_segment` 的 `score`（0–750）和 `rank`（>0）加了 `CHECK`，因为这两个是有物理含义的范围。
3. **主表同时保留名称和 ID**。`admission_score` 既存 `university_name` / `major_name`（你提供的 Excel 就有这两列，可直接导入、直接查询），
   又留了 `university_id` / `major_id` 外键（维度表补齐后回填，之后要做院校维度统计时 JOIN 即可）。
4. **时间戳用 INTEGER 存 Unix 秒**，`unixepoch()` 是 SQLite 内置函数，D1 支持；比 TEXT 时间省空间、好比较。
5. **唯一键就是 Excel 导入的去重键**，重复导入不会产生重复行。

## 执行方式

```bash
# 本地（不需要登录 Cloudflare）
wrangler d1 execute gaokao --local --file=./schema/01_schema.sql
wrangler d1 execute gaokao --local --file=./schema/02_seed.sql   # 灌入假数据

# 线上 D1（需要先 wrangler login，并在 wrangler.toml 里填好 database_id）
wrangler d1 execute gaokao --remote --file=./schema/01_schema.sql
```

## 目录里的其它 SQL 文件

| 文件 | 谁生成的 | 作用 |
| --- | --- | --- |
| `01_schema.sql` | 手写 | 建 4 张表 + 全部索引，`CREATE TABLE IF NOT EXISTS`，可重复执行 |
| `02_seed.sql` | `node scripts/build-data.mjs` | 假数据，按下面的行数写入 4 张表，开头先 `DELETE` 再插入，可反复执行 |
| `03_import.sql` | `node scripts/csv-to-sql.mjs 录取数据.csv` | 真实录取数据入库：写 `admission_score`，自动补齐 `university` / `major` 并回填外键 |
| `04_segments.sql` | `node scripts/csv-to-sql.mjs 一分一段.csv --segments` | 真实一分一段表入库 |

假数据规模（`02_seed.sql` 头部也会打印）：

| 表 | 行数 |
| --- | --- |
| `university` | 59 |
| `major` | 29 |
| `admission_score` | 5810（5 省 × 各科类 × 2023/2024 × 本科批/提前批/专科批） |
| `score_segment` | 9918（逐分，含 `rank` 与 `count`） |

假数据上线前可以先在本地验证接口：`node scripts/verify-d1.mjs` 会拿本地 D1 文件跑一遍
Worker 的 `/api/meta`、`/api/query`、`/api/recommend`，逐项检查关联字段、整数位次和三档推荐是否有结果。
导出的 CSV 模板在 `samples/` 下。
