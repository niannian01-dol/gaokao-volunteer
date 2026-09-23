/**
 * Excel/CSV -> D1 SQL（等你拿到真实数据后用它入库）。
 *
 * 两种模式：
 *   node scripts/csv-to-sql.mjs 录取数据.csv                # 写入 admission_score，并自动补齐院校表/专业表
 *   node scripts/csv-to-sql.mjs 一分一段.csv --segments     # 写入 score_segment（一分一段表）
 *
 * 常用参数：
 *   --json          顺便刷新 public/data/admission.json，让本地演示模式也用上真实数据
 *   --append        追加导入（不清空原表），适合按省/按年份分批导入
 *   --out my.sql    自定义输出文件（默认 schema/03_import.sql / schema/04_segments.sql）
 *
 * 生成后在项目里执行（本地演练把 --remote 换成 --local）：
 *   npx wrangler d1 execute gaokao --remote --file=./schema/03_import.sql
 *   npx wrangler d1 execute gaokao --remote --file=./schema/04_segments.sql
 *
 * Excel 里「另存为 CSV UTF-8」或直接「CSV（逗号分隔）」都可以，脚本会自动识别 GBK / UTF-8。
 */

import { readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 表头别名 -> admission_score 的列名（"@" 开头的列只用于补齐维度表，不入主表） */
const ADMISSION_COLUMNS = {
  province: "province",
  省份: "province",
  招生省份: "province",
  year: "year",
  年份: "year",
  招生年份: "year",
  subject_category: "subject_category",
  科类: "subject_category",
  选考科目: "subject_category",
  subject: "subject_category",
  batch: "batch",
  批次: "batch",
  录取批次: "batch",
  university_code: "university_code",
  院校代码: "university_code",
  学校代码: "university_code",
  university_name: "university_name",
  院校名称: "university_name",
  学校名称: "university_name",
  院校: "university_name",
  university_province: "@university_province",
  院校省份: "@university_province",
  院校所在省: "@university_province",
  所在省份: "@university_province",
  university_city: "@university_city",
  院校城市: "@university_city",
  城市: "@university_city",
  所在城市: "@university_city",
  university_tags: "@university_tags",
  院校标签: "@university_tags",
  标签: "@university_tags",
  university_type: "@university_type",
  院校类型: "@university_type",
  院校层次: "@university_type",
  层次: "@university_type",
  university_nature: "@university_nature",
  办学性质: "@university_nature",
  性质: "@university_nature",
  major_code: "major_code",
  专业代码: "major_code",
  major_name: "major_name",
  专业名称: "major_name",
  专业: "major_name",
  major_category: "@major_category",
  专业门类: "@major_category",
  门类: "@major_category",
  major_sub_category: "@major_sub_category",
  专业大类: "@major_sub_category",
  大类: "@major_sub_category",
  专业类: "@major_sub_category",
  plan_count: "plan_count",
  计划数: "plan_count",
  招生计划: "plan_count",
  招生人数: "plan_count",
  min_score: "min_score",
  最低分: "min_score",
  最低分数: "min_score",
  min_rank: "min_rank",
  最低位次: "min_rank",
  最低排名: "min_rank",
};

/** 表头别名 -> score_segment 的列名 */
const SEGMENT_COLUMNS = {
  province: "province",
  省份: "province",
  year: "year",
  年份: "year",
  subject_category: "subject_category",
  科类: "subject_category",
  subject: "subject_category",
  score: "score",
  分数: "score",
  rank: "rank",
  位次: "rank",
  累计位次: "rank",
  累计人数: "rank",
  count: "count",
  本段人数: "count",
  人数: "count",
};

const SEGMENT_REQUIRED = ["province", "year", "subject_category", "score", "rank"];
const ADMISSION_REQUIRED = ["province", "year", "subject_category", "batch", "university_name", "major_name"];
const NUMERIC = new Set(["year", "plan_count", "min_score", "min_rank", "score", "rank", "count"]);

/** 真正写进 admission_score 的列（维度字段会先补齐 university / major 表，再回填 id） */
const ADMISSION_TABLE_COLUMNS = [
  "province",
  "year",
  "subject_category",
  "batch",
  "university_code",
  "university_name",
  "major_code",
  "major_name",
  "min_score",
  "min_rank",
  "plan_count",
];

/** 先按 UTF-8 解码，出现替换字符就退回 GBK（Excel 中文 CSV 默认编码）。 */
function decode(buffer) {
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("gbk").decode(buffer);
  } catch {
    return utf8;
  }
}

/** 支持引号包裹、双引号转义的 CSV 解析。 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  const clean = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\r") {
      /* 忽略 */
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ""));
}

const sqlValue = (value) => {
  if (value === undefined || value === null || value === "") return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
};

function toNumber(value) {
  const text = String(value ?? "").replace(/[,，\s]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** 生成批量 INSERT；verb 可以传 "INSERT OR IGNORE" 这类变体。 */
function insertStatements(table, columns, rows, { batchSize = 150, verb = "INSERT" } = {}) {
  const out = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const values = rows
      .slice(i, i + batchSize)
      .map((row) => `  (${columns.map((c) => sqlValue(row[c] ?? null)).join(", ")})`)
      .join(",\n");
    out.push(`${verb} INTO ${table} (${columns.join(", ")}) VALUES\n${values};`);
  }
  return out.join("\n\n");
}

/** 把「985工程」这类写法收敛到表里约定的取值。 */
function normalizeType(value) {
  const text = String(value ?? "").trim();
  if (text.includes("985")) return "985";
  if (text.includes("211")) return "211";
  if (text.includes("双一流")) return "双一流";
  return text || "普通";
}

function normalizeNature(value) {
  const text = String(value ?? "").trim();
  if (text.includes("民办") || text.includes("私立")) return "民办";
  return "公办";
}

function readRows(input, columnMap, fileLabel) {
  const text = decode(readFileSync(input));
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error(`${fileLabel} 里没有数据行`);
  const header = rows[0].map((h) => columnMap[String(h).trim()] || null);
  const mapped = header.filter(Boolean);
  return { rows, header, mapped };
}

/* --------------------------- 模式一：录取数据 --------------------------- */

async function buildAdmissionSql(input, outFile, { alsoJson = false, append = false } = {}) {
  const { rows, header, mapped } = readRows(input, ADMISSION_COLUMNS, "录取数据 CSV");
  const missing = ADMISSION_REQUIRED.filter((key) => !mapped.includes(key));
  if (missing.length) {
    throw new Error(
      `缺少必要列：${missing.join(", ")}\n表头识别结果：${rows[0].join(" | ")}\n需要包含：省份、年份、科类、批次、院校名称、专业名称`,
    );
  }

  const records = [];
  for (const row of rows.slice(1)) {
    const record = {};
    header.forEach((column, index) => {
      if (!column) return;
      const key = column.replace(/^@/, "");
      const raw = row[index];
      record[key] = NUMERIC.has(key) ? toNumber(raw) : String(raw ?? "").trim();
    });
    if (!record.university_name || !record.major_name) continue;
    records.push(record);
  }
  if (!records.length) throw new Error("没有解析到有效数据行");

  // 院校表 / 专业表：按名称去重，名称重复的只留第一条（院校代码、门类等以第一条为准）。
  const universityMap = new Map();
  const majorMap = new Map();
  for (const record of records) {
    if (!universityMap.has(record.university_name)) {
      universityMap.set(record.university_name, {
        university_code: record.university_code || record.university_name,
        name: record.university_name,
        province: record.university_province || null,
        city: record.university_city || null,
        type: normalizeType(record.university_type),
        nature: normalizeNature(record.university_nature ?? record.university_tags),
        tags: record.university_tags || record.university_type || null,
      });
    }
    if (!majorMap.has(record.major_name)) {
      majorMap.set(record.major_name, {
        major_code: record.major_code || record.major_name,
        name: record.major_name,
        category: record.major_category || "未分类",
        sub_category: record.major_sub_category || null,
      });
    }
  }

  const sql = [
    `-- 由 scripts/csv-to-sql.mjs 生成，来源：${input}`,
    "-- 执行：npx wrangler d1 execute gaokao --remote --file=" + outFile.replace(root, ".").replace(/\\/g, "/"),
    "--",
    `-- 录取记录 ${records.length} 行 / 院校 ${universityMap.size} 所 / 专业 ${majorMap.size} 个`,
    "",
    append
      ? "-- 1) 追加导入：不清空原表（表结构见 schema/01_schema.sql）"
      : "-- 1) 整表替换：先清空主表再写入（表结构见 schema/01_schema.sql）",
    ...(append ? [] : ["DELETE FROM admission_score;"]),
    "",
    insertStatements("admission_score", ADMISSION_TABLE_COLUMNS, records),
    "",
    "-- 2) 补齐院校表 / 专业表；已存在的记录不覆盖，方便你手工维护过的字段",
    insertStatements(
      "university",
      ["university_code", "name", "province", "city", "type", "nature", "tags"],
      [...universityMap.values()],
      { verb: "INSERT OR IGNORE" },
    ),
    "",
    insertStatements(
      "major",
      ["major_code", "name", "category", "sub_category"],
      [...majorMap.values()],
      { verb: "INSERT OR IGNORE" },
    ),
    "",
    "-- 3) 回填外键：按名称把 admission_score 关联到维度表",
    "UPDATE admission_score SET university_id = (SELECT u.id FROM university u WHERE u.name = admission_score.university_name) WHERE university_id IS NULL;",
    "UPDATE admission_score SET major_id = (SELECT m.id FROM major m WHERE m.name = admission_score.major_name) WHERE major_id IS NULL;",
    "",
  ].join("\n");

  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, sql, "utf8");

  if (alsoJson) {
    // 本地演示模式读的是 public/data/admission.json，字段名保持不变（多出来的列前端会显示「—」）。
    const jsonRows = records.map((r) => ({
      province: r.province,
      year: r.year,
      subject_category: r.subject_category,
      batch: r.batch,
      university_code: r.university_code || "",
      university_name: r.university_name,
      university_province: r.university_province || "",
      university_city: r.university_city || "",
      university_tags: r.university_tags || r.university_type || "",
      major_code: r.major_code || "",
      major_name: r.major_name,
      plan_count: r.plan_count ?? null,
      min_score: r.min_score ?? null,
      min_rank: r.min_rank ?? null,
    }));
    await writeFile(join(root, "public", "data", "admission.json"), JSON.stringify(jsonRows), "utf8");
  }

  console.log(`已解析 ${records.length} 行 -> ${outFile}`);
  console.log(`院校 ${universityMap.size} 所 / 专业 ${majorMap.size} 个`);
  if (alsoJson) console.log("已同步 public/data/admission.json（本地演示模式会读取它）");
  console.log(`\n下一步：npx wrangler d1 execute gaokao --remote --file=${outFile.replace(root, ".").replace(/\\/g, "/")}`);
}

/* --------------------------- 模式二：一分一段 --------------------------- */

async function buildSegmentSql(input, outFile, { append = false } = {}) {
  const { rows, header, mapped } = readRows(input, SEGMENT_COLUMNS, "一分一段 CSV");
  const missing = SEGMENT_REQUIRED.filter((key) => !mapped.includes(key));
  if (missing.length) {
    throw new Error(
      `缺少必要列：${missing.join(", ")}\n表头识别结果：${rows[0].join(" | ")}\n需要包含：省份、年份、科类、分数、位次`,
    );
  }

  const records = [];
  for (const row of rows.slice(1)) {
    const record = {};
    header.forEach((column, index) => {
      if (!column) return;
      const raw = row[index];
      record[column] = NUMERIC.has(column) ? toNumber(raw) : String(raw ?? "").trim();
    });
    if (record.score == null || record.rank == null) continue;
    record.cumulative_count = record.rank;
    records.push(record);
  }
  if (!records.length) throw new Error("没有解析到有效数据行");

  const sql = [
    `-- 由 scripts/csv-to-sql.mjs 生成，来源：${input}`,
    "-- 执行：npx wrangler d1 execute gaokao --remote --file=" + outFile.replace(root, ".").replace(/\\/g, "/"),
    "",
    `-- 一分一段记录 ${records.length} 行`,
    ...(append ? ["-- 追加导入：不清空原表"] : ["DELETE FROM score_segment;"]),
    "",
    insertStatements(
      "score_segment",
      ["province", "year", "subject_category", "score", "rank", "count", "cumulative_count"],
      records,
      { batchSize: 300 },
    ),
    "",
  ].join("\n");

  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, sql, "utf8");
  console.log(`已解析 ${records.length} 行 -> ${outFile}`);
}

/* ------------------------------- 入口 ------------------------------- */

async function main() {
  const args = process.argv.slice(2);
  const input = args.find((a) => !a.startsWith("--"));
  const segments = args.includes("--segments");
  if (!input) {
    console.error(
      [
        "用法：",
        "  node scripts/csv-to-sql.mjs 录取数据.csv [--json] [--out 路径]",
        "  node scripts/csv-to-sql.mjs 一分一段.csv --segments [--out 路径]",
      ].join("\n"),
    );
    process.exit(1);
  }
  const outFlag = args.indexOf("--out");
  const append = args.includes("--append");
  const outFile = resolve(
    root,
    outFlag >= 0 ? args[outFlag + 1] : segments ? "schema/04_segments.sql" : "schema/03_import.sql",
  );
  const file = resolve(process.cwd(), input);

  if (segments) await buildSegmentSql(file, outFile, { append });
  else await buildAdmissionSql(file, outFile, { alsoJson: args.includes("--json"), append });
}

main().catch((error) => {
  console.error(`导入失败：${error.message}`);
  process.exit(1);
});
