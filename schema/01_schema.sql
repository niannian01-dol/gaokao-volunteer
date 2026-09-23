-- =====================================================================
-- 高考志愿填报查询平台 · 数据库表结构（Cloudflare D1 / SQLite）
-- 文件：schema/01_schema.sql
--
-- 说明：
--   1. D1 基于 SQLite，SQLite 不支持 COMMENT ON COLUMN 语法，
--      因此每个字段的注释以行内 "-- ..." 形式写在字段后面，
--      完整字段说明见 schema/README.md。
--   2. 所有建表语句都是 CREATE TABLE IF NOT EXISTS，可重复执行不会毁数据。
--   3. 位次、分数、人数一律用 INTEGER（位次字段要求整数类型）。
--   4. 科类/批次等枚举值不做 CHECK 约束，避免你 Excel 里写法不一致时导入直接失败，
--      取值约定见文件末尾注释。
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- 1. university 院校表
--    一个院校一行，作为院校维度的主数据。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS university (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,        -- 主键，自增
  university_code TEXT    NOT NULL,                         -- 院校代码：教育部统一代码，Excel 导入时的匹配键
  name            TEXT    NOT NULL,                         -- 院校名称，如「清华大学」
  province        TEXT    NOT NULL,                         -- 所在省份，如「江苏」
  city            TEXT,                                     -- 所在城市，如「南京」
  type            TEXT    NOT NULL DEFAULT '普通',          -- 院校类型：985 / 211 / 双一流 / 普通（取最高层次）
  nature          TEXT    NOT NULL DEFAULT '公办',          -- 办学性质：公办 / 民办
  tags            TEXT,                                     -- 层次标签，逗号分隔，可多值，如「985,211,双一流」
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),   -- 创建时间，Unix 秒
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())    -- 更新时间，Unix 秒
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_university_code ON university (university_code);      -- 院校代码唯一
CREATE UNIQUE INDEX IF NOT EXISTS ux_university_name ON university (name);                 -- 院校名称唯一
CREATE INDEX IF NOT EXISTS ix_university_province     ON university (province);            -- 按省份筛选
CREATE INDEX IF NOT EXISTS ix_university_type         ON university (type);                -- 按 985/211 等筛选
CREATE INDEX IF NOT EXISTS ix_university_nature       ON university (nature);              -- 按办学性质筛选

-- ---------------------------------------------------------------------
-- 2. major 专业表
--    一个专业一行（教育部专业目录维度）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS major (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,        -- 主键，自增
  major_code   TEXT    NOT NULL,                         -- 专业代码：教育部专业目录代码，如 080901
  name         TEXT    NOT NULL,                         -- 专业名称，如「计算机科学与技术」
  category     TEXT    NOT NULL,                         -- 所属门类，如「工学」（哲学/经济学/法学/教育学/文学/历史学/理学/工学/农学/医学/管理学/艺术学）
  sub_category TEXT,                                     -- 所属大类（专业类），如「计算机类」
  degree       TEXT,                                     -- 授予学位门类，如「工学学士」
  duration     INTEGER,                                  -- 标准学制（年），如 4
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),   -- 创建时间，Unix 秒
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())    -- 更新时间，Unix 秒
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_major_code ON major (major_code);                     -- 专业代码唯一
CREATE INDEX IF NOT EXISTS ix_major_name          ON major (name);                         -- 按专业名筛选
CREATE INDEX IF NOT EXISTS ix_major_category      ON major (category, sub_category);       -- 按门类 / 大类筛选

-- ---------------------------------------------------------------------
-- 3. admission_score 历年录取分数表
--    一个「省份 + 年份 + 科类 + 批次 + 院校 + 专业」一行，是平台的主表。
--    university_id / major_id 关联维度表，同时保留名称字段，
--    这样 Excel 直接导入也能查，不用先建好维度表。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admission_score (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,       -- 主键，自增
  province         TEXT    NOT NULL,                        -- 招生省份（考生所在省），如「江苏」
  year             INTEGER NOT NULL,                        -- 录取年份，如 2024
  subject_category TEXT    NOT NULL,                        -- 科类：文科 / 理科 / 物理类 / 历史类 / 综合
  batch            TEXT    NOT NULL,                        -- 批次：提前批 / 本科批 / 专科批
  university_code  TEXT,                                    -- 院校代码（冗余，便于和 Excel 对齐）
  university_name  TEXT    NOT NULL,                        -- 院校名称
  university_id    INTEGER,                                 -- 关联 university.id，未匹配到维度表时为 NULL
  major_code       TEXT,                                    -- 专业代码（冗余，便于和 Excel 对齐）
  major_name       TEXT    NOT NULL,                        -- 专业名称
  major_id         INTEGER,                                 -- 关联 major.id，未匹配到维度表时为 NULL
  min_score        INTEGER,                                 -- 最低分（录取最低分）
  min_rank         INTEGER,                                 -- 最低位次（整数），冲稳保分档的核心字段
  plan_count       INTEGER,                                 -- 招生人数（招生计划数）
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),  -- 创建时间，Unix 秒
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),  -- 更新时间，Unix 秒
  FOREIGN KEY (university_id) REFERENCES university (id) ON DELETE SET NULL,
  FOREIGN KEY (major_id)      REFERENCES major (id)      ON DELETE SET NULL
);

-- 唯一键：同一省份/年份/科类/批次下，同一院校同一专业只应有一条记录（Excel 重复导入靠它去重）
CREATE UNIQUE INDEX IF NOT EXISTS ux_admission_key
  ON admission_score (province, year, subject_category, batch, university_name, major_name);

-- 查询主索引：查询页按 省份+年份+科类+批次 过滤，并按位次排序
CREATE INDEX IF NOT EXISTS ix_admission_query
  ON admission_score (province, year, subject_category, batch, min_rank);
-- 推荐索引：冲稳保按「省份+科类+位次」扫区间（不限定年份/批次时也能用）
CREATE INDEX IF NOT EXISTS ix_admission_rank
  ON admission_score (province, subject_category, min_rank);
-- 单列索引：按院校名 / 专业名模糊查询
CREATE INDEX IF NOT EXISTS ix_admission_university ON admission_score (university_name);
CREATE INDEX IF NOT EXISTS ix_admission_major      ON admission_score (major_name);

-- ---------------------------------------------------------------------
-- 4. score_segment 一分一段表
--    一个「省份 + 年份 + 科类 + 分数」一行，用于分数 <-> 位次换算。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS score_segment (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,       -- 主键，自增
  province         TEXT    NOT NULL,                        -- 省份，如「江苏」
  year             INTEGER NOT NULL,                        -- 年份，如 2024
  subject_category TEXT    NOT NULL,                        -- 科类：文科 / 理科 / 物理类 / 历史类 / 综合
  score            INTEGER NOT NULL,                        -- 分数（整数）
  rank             INTEGER NOT NULL,                        -- 该分数对应的位次（累计位次，整数）
  count            INTEGER,                                 -- 本分数段人数（可选，有些省份不公布）
  cumulative_count INTEGER,                                 -- 累计人数（可选，= 该分数及以上总人数）
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),  -- 创建时间，Unix 秒
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),  -- 更新时间，Unix 秒
  CHECK (score >= 0 AND score <= 750),                      -- 分数范围保护（750 为全国最高满分）
  CHECK (rank  >  0)                                        -- 位次必须为正整数
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_segment_key
  ON score_segment (province, year, subject_category, score);          -- 同省同年同科类同分数唯一
CREATE INDEX IF NOT EXISTS ix_segment_rank
  ON score_segment (province, year, subject_category, rank);           -- 位次换算时按位次查

-- =====================================================================
-- 取值约定（不写 CHECK，方便 Excel 原样导入后再清洗）
--   university.type            : 985 | 211 | 双一流 | 普通
--   university.nature          : 公办 | 民办
--   admission_score.subject_category / score_segment.subject_category
--                              : 文科 | 理科 | 物理类 | 历史类 | 综合
--   admission_score.batch      : 提前批 | 本科批 | 专科批
-- =====================================================================