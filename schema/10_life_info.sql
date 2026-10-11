-- =====================================================================
-- 院校生活信息（宿舍条件等）· 独立建表 SQL（Cloudflare D1 / SQLite）
-- 文件：schema/10_life_info.sql
--
-- 设计要点：
--   1. 与分数 / 位次 / 专业推荐表完全解耦，仅通过「院校名称 + 校区」关联。
--   2. 严格区分校区：campus 为必填，(university_name, campus) 唯一。
--   3. 「是否有晚自习」等带备注字段用 TEXT 存储，支持「是【大一有】」格式。
--   4. 来源可追溯：source + source_url + verified + verify_count。
--      verified=1 表示「同校区两条一致投稿交叉核验通过」，否则一律待核验。
--   5. 数据纪律：字段只允许来自明确来源的原始值，禁止 AI 编造字段。
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- 1. campus_life 院校生活信息主表
--    一行 = 一个「院校 + 校区」的宿舍/生活信息。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campus_life (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  university_name  TEXT    NOT NULL,                        -- 院校名称，与 university.name 对齐
  campus           TEXT    NOT NULL DEFAULT '主校区',       -- 校区，严格区分（如「主校区」「XX校区」）
  province         TEXT,                                    -- 所在省份（冗余，便于检索）
  city             TEXT,                                    -- 所在城市

  roommates        TEXT,                                    -- 几人寝，如「普遍 4 人寝」
  lights_out       TEXT,                                    -- 熄灯 / 锁门
  transport        TEXT,                                    -- 出行、休闲是否方便
  bed_desk         TEXT,                                    -- 是否上床下桌
  morning_exercise TEXT,                                    -- 是否有早操
  evening_study    TEXT,                                    -- 是否有晚自习（字符串，支持「是【大一有】」）
  bathroom         TEXT,                                    -- 是否独立卫浴
  air_conditioner  TEXT,                                    -- 是否独立空调
  takeout          TEXT,                                    -- 能否点外卖
  canteen          TEXT,                                    -- 食堂是否实惠好吃
  extra            TEXT,                                    -- 额外描述

  source           TEXT    NOT NULL,                        -- 来源：CollegesChat / sushe.help / 投稿 / 社交平台
  source_url       TEXT,                                    -- 来源链接
  verified         INTEGER NOT NULL DEFAULT 0,              -- 0=待核验 1=可信（同校区双源一致）
  verify_count     INTEGER NOT NULL DEFAULT 0,              -- 一致投稿条数
  first_seen_at    TEXT,                                    -- 首次收录时间
  updated_at       TEXT,                                    -- 最后更新时间

  UNIQUE (university_name, campus)
);

CREATE INDEX IF NOT EXISTS ix_campus_life_university ON campus_life (university_name);
CREATE INDEX IF NOT EXISTS ix_campus_life_verified    ON campus_life (verified);

-- ---------------------------------------------------------------------
-- 2. life_submission 在校生投稿原始表
--    每一条投稿都保留原文，便于追溯与「同校区两条一致才可信」的交叉核验。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS life_submission (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  university_name TEXT    NOT NULL,                        -- 院校名称
  campus          TEXT    NOT NULL DEFAULT '主校区',       -- 校区
  payload         TEXT    NOT NULL,                        -- JSON：投稿的原始字段
  source          TEXT    NOT NULL DEFAULT '投稿',         -- 来源标识
  submitter       TEXT,                                    -- 投稿人标识（可匿名，仅用于去重）
  status          TEXT    NOT NULL DEFAULT 'pending',      -- pending / accepted / rejected
  reviewed_at     TEXT,                                    -- 审核时间
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_life_submission_key ON life_submission (university_name, campus, status);
