/**
 * 生成演示假数据，一次产出四份文件：
 *   public/data/admission.json        院校专业录取记录（前端演示模式 + 本地服务共用）
 *   public/data/score-segments.json   一分一段表
 *   public/data/meta.json             筛选器选项
 *   schema/02_seed.sql                D1 种子数据，写入 schema/01_schema.sql 里的 4 张表
 *
 * 用法：node scripts/build-data.mjs
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BATCHES,
  MAJOR_POOL,
  PROVINCES,
  SCHOOLS,
  YEARS,
  generateAdmissions,
  generateSegments,
  universityNature,
  universityType,
} from "./lib/data-model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/* ---------------------------- SQL 工具 ---------------------------- */

function sqlValue(value) {
  if (value === null || value === undefined || value === "") return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function insertStatements(table, columns, rows, batchSize = 150) {
  const out = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const values = slice
      .map((row) => `  (${columns.map((c) => sqlValue(row[c])).join(", ")})`)
      .join(",\n");
    out.push(`INSERT INTO ${table} (${columns.join(", ")}) VALUES\n${values};`);
  }
  return out.join("\n\n");
}

/* --------------------------- 四张表的数据 --------------------------- */

/** university 院校表：一所院校一行，type 取最高层次，nature 由标签推导。 */
function buildUniversities() {
  return SCHOOLS.map((school, index) => ({
    id: index + 1,
    university_code: school.code,
    name: school.name,
    province: school.province,
    city: school.city,
    type: universityType(school.tags),
    nature: universityNature(school.tags),
    tags: school.tags,
  }));
}

/** major 专业表：一个专业一行，代码用教育部专业目录代码。 */
function buildMajors() {
  return MAJOR_POOL.map((major, index) => ({
    id: index + 1,
    major_code: major.code,
    name: major.name,
    category: major.category,
    sub_category: major.subCategory,
    degree: major.degree,
    duration: major.years,
  }));
}

/**
 * admission_score 历年录取分数表。
 * 只保留新表结构里的列（旧演示数据里的学费/学制/专业组等字段不属于本表，直接丢弃）。
 * university_id / major_id 在这里按名称回填，模拟"维度表已补齐"的状态。
 */
function buildAdmissions(universities, majors) {
  const universityId = new Map(universities.map((u) => [u.name, u.id]));
  const majorId = new Map(majors.map((m) => [m.name, m.id]));
  const majorCode = new Map(majors.map((m) => [m.name, m.major_code]));

  return generateAdmissions().map((row) => ({
    province: row.province,
    year: row.year,
    subject_category: row.subject_category,
    batch: row.batch,
    university_code: row.university_code,
    university_name: row.university_name,
    university_id: universityId.get(row.university_name) ?? null,
    major_code: majorCode.get(row.major_name) ?? null,
    major_name: row.major_name,
    major_id: majorId.get(row.major_name) ?? null,
    min_score: row.min_score,
    min_rank: row.min_rank,
    plan_count: row.plan_count,
  }));
}

/**
 * score_segment 一分一段表：把嵌套 JSON 摊平成"每省每年每科类每分一行"。
 * rank = 该分数及以上累计人数（即位次），cumulative_count 与它同义，
 * count = 考出这个分数的人数 = 本档累计 - 下一档累计。
 */
function buildSegments() {
  const nested = generateSegments();
  const rows = [];
  for (const [province, bySubject] of Object.entries(nested)) {
    for (const [subject, byYear] of Object.entries(bySubject)) {
      for (const [year, list] of Object.entries(byYear)) {
        list.forEach(([score, rank], index) => {
          const nextRank = index + 1 < list.length ? list[index + 1][1] : 0;
          rows.push({
            province,
            year: Number(year),
            subject_category: subject,
            score,
            rank,
            count: Math.max(0, rank - nextRank),
            cumulative_count: rank,
          });
        });
      }
    }
  }
  return rows;
}

/* ------------------------------- 入口 ------------------------------- */

async function main() {
  const universities = buildUniversities();
  const majors = buildMajors();
  const admissions = buildAdmissions(universities, majors);
  const segments = buildSegments();

  const meta = {
    generatedAt: new Date().toISOString(),
    dataset: "demo",
    warning:
      "当前为占位假数据，仅用于跑通流程；接入真实数据后请整体替换 public/data/*.json 与 schema/02_seed.sql。",
    provinces: PROVINCES.map((p) => p.name),
    years: [...YEARS],
    batches: [...BATCHES],
    subjectsByProvince: Object.fromEntries(PROVINCES.map((p) => [p.name, p.subjects])),
    stats: {
      admissionRows: admissions.length,
      universities: universities.length,
      majors: majors.length,
      segmentRows: segments.length,
      provinces: PROVINCES.length,
      years: YEARS.length,
    },
  };

  // 数据放在 public/data 下：本地演示、静态部署、无后端降级模式都能直接读。
  const dataDir = join(root, "public", "data");
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(root, "schema"), { recursive: true });

  await writeFile(join(dataDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  await writeFile(join(dataDir, "admission.json"), `${JSON.stringify(generateAdmissions())}\n`, "utf8");
  await writeFile(join(dataDir, "score-segments.json"), `${JSON.stringify(generateSegments())}\n`, "utf8");

  const header = [
    "-- 由 scripts/build-data.mjs 自动生成，请勿手工编辑。",
    "-- 表结构见 schema/01_schema.sql；作用是先灌一批假数据把「查询 -> 结果 -> 推荐」跑通。",
    "-- 执行：npx wrangler d1 execute gaokao --remote --file=./schema/02_seed.sql",
    "--       本地演练：npx wrangler d1 execute gaokao --local  --file=./schema/02_seed.sql",
    "--",
    `-- 数据量：院校 ${universities.length} 所 / 专业 ${majors.length} 个 / 录取记录 ${admissions.length} 条 / 一分一段 ${segments.length} 条`,
    "",
    "-- 先清空再写入：admission_score 有外键指向 university / major，所以先删主表。",
    "DELETE FROM admission_score;",
    "DELETE FROM score_segment;",
    "DELETE FROM major;",
    "DELETE FROM university;",
    "",
  ].join("\n");

  const sql = [
    header,
    "/* ---------------------------- 1. 院校表 ---------------------------- */",
    insertStatements(
      "university",
      ["id", "university_code", "name", "province", "city", "type", "nature", "tags"],
      universities,
    ),
    "",
    "/* ---------------------------- 2. 专业表 ---------------------------- */",
    insertStatements(
      "major",
      ["id", "major_code", "name", "category", "sub_category", "degree", "duration"],
      majors,
    ),
    "",
    "/* ------------------------ 3. 历年录取分数表 ------------------------ */",
    insertStatements(
      "admission_score",
      [
        "province",
        "year",
        "subject_category",
        "batch",
        "university_code",
        "university_name",
        "university_id",
        "major_code",
        "major_name",
        "major_id",
        "min_score",
        "min_rank",
        "plan_count",
      ],
      admissions,
    ),
    "",
    "/* -------------------------- 4. 一分一段表 -------------------------- */",
    insertStatements(
      "score_segment",
      ["province", "year", "subject_category", "score", "rank", "count", "cumulative_count"],
      segments,
      300,
    ),
    "",
  ].join("\n");

  await writeFile(join(root, "schema", "02_seed.sql"), sql, "utf8");

  console.log(
    [
      "已生成：",
      `  public/data/admission.json        ${admissions.length} 条录取记录`,
      `  public/data/score-segments.json   ${segments.length} 条一分一段记录`,
      "  public/data/meta.json             筛选器选项",
      `  schema/02_seed.sql                ${(sql.length / 1024).toFixed(0)} KB（university ${universities.length} / major ${majors.length} / admission_score ${admissions.length} / score_segment ${segments.length}）`,
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
