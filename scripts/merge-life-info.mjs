/**
 * 院校生活信息（宿舍条件等）合并 / 清洗脚本。
 *
 * 用途：
 *   把多来源的宿舍信息（CollegesChat、sushe.help 公开 JSON、在校生投稿）
 *   映射到统一字段，按「院校名称 + 校区」去重合并，并做同校区交叉核验，
 *   最终输出前端读取的 university-info.json，可选输出 D1 的 INSERT SQL。
 *
 * 用法：
 *   node scripts/merge-life-info.mjs \
 *     [--collegeschat raw/collegeschat.json] \
 *     [--sushe raw/sushe-help.json] \
 *     [--submissions raw/submissions.json] \
 *     [--existing public/data/university-info.json] \
 *     [--out public/data/university-info.json] \
 *     [--sql schema/11_life_seed.sql]
 *
 * 数据纪律（不可违反）：
 *   1. 只做「映射 + 清洗 + 合并」，绝不生成/编造字段值；来源缺失的字段保持为空。
 *   2. 严格区分校区：主键为「院校名称 + 校区」。
 *   3. 同校区两条「字段完全一致」的投稿才标记 verified=1（可信）。
 *   4. 「是否有晚自习」等字段按字符串存储，支持「是【大一有】」格式。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------ 参数 ------------------------------ */

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const PATH = {
  collegeschat: arg("--collegeschat", null),
  sushe: arg("--sushe", null),
  submissions: arg("--submissions", null),
  existing: arg("--existing", "public/data/university-info.json"),
  out: arg("--out", "public/data/university-info.json"),
  sql: arg("--sql", null),
};

/* --------------------------- 目标字段 --------------------------- */

/** 前端字段定义（与 university-info.json 的 sections[].fields 保持一致）。 */
const DORM_FIELDS = [
  { key: "roommates", label: "几人寝", kind: "text" },
  { key: "lightsOut", label: "熄灯 / 锁门", kind: "text" },
  { key: "transport", label: "出行、休闲是否方便", kind: "text" },
  { key: "bedDesk", label: "是否上床下桌", kind: "yesno" },
  { key: "morningExercise", label: "是否有早操", kind: "yesno" },
  { key: "eveningStudy", label: "是否有晚自习", kind: "text" },
  { key: "bathroom", label: "是否独立卫浴", kind: "yesno" },
  { key: "airConditioner", label: "是否独立空调", kind: "yesno" },
  { key: "takeout", label: "能否点外卖", kind: "text" },
  { key: "canteen", label: "食堂是否实惠好吃", kind: "yesno" },
  { key: "note", label: "额外描述", kind: "text" },
];

const TARGET_KEYS = new Set(DORM_FIELDS.map((f) => f.key));

/** 前端渲染用的板块定义。 */
const SECTIONS = [{ key: "dormitory", title: "宿舍条件", icon: "🛏️", fields: DORM_FIELDS }];

/** 来源字段别名 -> 目标字段。新来源只需在这里补一行即可。 */
const FIELD_ALIASES = {
  几人寝: "roommates",
  宿舍人数: "roommates",
  roommates: "roommates",
  熄灯锁门: "lightsOut",
  熄灯: "lightsOut",
  "熄灯/锁门": "lightsOut",
  lightsOut: "lightsOut",
  出行: "transport",
  交通: "transport",
  出行休闲: "transport",
  transport: "transport",
  上床下桌: "bedDesk",
  bedDesk: "bedDesk",
  早操: "morningExercise",
  morningExercise: "morningExercise",
  晚自习: "eveningStudy",
  eveningStudy: "eveningStudy",
  卫浴: "bathroom",
  独立卫浴: "bathroom",
  bathroom: "bathroom",
  空调: "airConditioner",
  独立空调: "airConditioner",
  airConditioner: "airConditioner",
  外卖: "takeout",
  takeout: "takeout",
  食堂: "canteen",
  canteen: "canteen",
  备注: "note",
  额外描述: "note",
  note: "note",
  extra: "note",
};

/** 院校名称 / 校区可能出现的键名。 */
const NAME_KEYS = ["university", "universityName", "university_name", "school", "name", "院校", "学校"];
const CAMPUS_KEYS = ["campus", "校区", "campusName"];
const SOURCE_URL_KEYS = ["sourceUrl", "source_url", "url", "link"];

/* ---------------------------- 工具 ---------------------------- */

const clean = (v) => {
  if (v == null) return "";
  return String(v).replace(/\s+/g, " ").trim();
};

/** 布尔字段的轻量归一：仅把孤立的「有/无」归一成「是/否」，其余原样保留。 */
function normalizeValue(key, value) {
  const text = clean(value);
  if (!text) return "";
  if (DORM_FIELDS.find((f) => f.key === key)?.kind === "yesno") {
    if (/^有$/.test(text)) return "是";
    if (/^无$/.test(text)) return "否";
  }
  return text;
}

function pick(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] != null && obj[key] !== "") return clean(obj[key]);
  }
  return "";
}

/** 把来源记录映射成 { name, campus, fields, source, sourceUrl, submitter }。 */
function mapRecord(record, sourceName) {
  const name = pick(record, NAME_KEYS);
  if (!name) return null;
  const campus = pick(record, CAMPUS_KEYS) || "主校区";
  const fields = {};
  for (const [key, value] of Object.entries(record || {})) {
    const target = FIELD_ALIASES[key];
    if (target && TARGET_KEYS.has(target)) {
      fields[target] = normalizeValue(target, value);
    }
  }
  const hasAnyField = TARGET_KEYS && Object.values(fields).some((v) => v !== "");
  if (!hasAnyField) return null;
  return {
    name,
    campus,
    fields,
    source: sourceName,
    sourceUrl: pick(record, SOURCE_URL_KEYS),
    submitter: pick(record, ["submitter", "投稿人", "user"]),
    raw: record,
  };
}

const recordKey = (name, campus) => `${name}\u0000${campus || "主校区"}`;

/* --------------------------- 读取 --------------------------- */

async function readJson(path) {
  const raw = await readFile(resolve(root, path), "utf8");
  return JSON.parse(raw);
}

async function readOptional(path) {
  if (!path) return [];
  try {
    return await readJson(path);
  } catch {
    console.warn(`  [跳过] 未找到 ${path}`);
    return [];
  }
}

/** 兼容旧格式：把 school -> sections 迁移成 school -> campuses。 */
function normalizeExisting(data) {
  const out = { ...data, universities: {} };
  for (const [name, entry] of Object.entries(data?.universities || {})) {
    const campuses = entry?.campuses
      ? entry.campuses
      : {
          主校区: {
            verified: entry?.verified,
            source: entry?.source,
            sourceUrl: entry?.sourceUrl,
            updatedAt: entry?.updatedAt,
            verifyCount: entry?.verifyCount,
            sections: entry?.sections,
          },
        };
    out.universities[name] = {
      profile: entry?.profile || entry?.profileData || {},
      campuses,
    };
  }
  return out;
}

/* --------------------------- 合并 --------------------------- */

function addRecord(acc, rec, { fromSubmission = false } = {}) {
  const key = recordKey(rec.name, rec.campus);
  if (!acc.has(key)) {
    acc.set(key, {
      name: rec.name,
      campus: rec.campus,
      fields: {},
      source: rec.source,
      sourceUrl: rec.sourceUrl,
      verified: false,
      verifyCount: 0,
      submissions: [],
    });
  }
  const entry = acc.get(key);
  if (fromSubmission) {
    entry.submissions.push(rec.fields);
  }
  // 投稿为长期主数据源：投稿字段优先于种子字段。
  const priority = fromSubmission ? 1 : 0;
  if (priority >= 1 || entry.source !== rec.source) {
    entry.source = rec.source;
    entry.sourceUrl = rec.sourceUrl || entry.sourceUrl;
  }
  for (const [k, v] of Object.entries(rec.fields)) {
    if (v !== "" && (fromSubmission || !entry.fields[k])) {
      entry.fields[k] = v;
    }
  }
  return entry;
}

function applyCrossVerification(entry) {
  if (entry.submissions.length < 2) return;
  const consistent = new Map();
  for (const fields of entry.submissions) {
    const sig = JSON.stringify(Object.fromEntries(Object.entries(fields).sort()));
    consistent.set(sig, (consistent.get(sig) || 0) + 1);
  }
  const [sig, count] = [...consistent.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  if (count >= 2) {
    const agreed = JSON.parse(sig);
    for (const [k, v] of Object.entries(agreed)) entry.fields[k] = v;
    entry.verified = true;
    entry.verifyCount = count;
    entry.source = "投稿（同校区双源交叉核验）";
  }
}

/* --------------------------- 输出 --------------------------- */

function toOutput(acc, sections) {
  const universities = {};
  for (const entry of acc.values()) {
    const school = (universities[entry.name] ||= { profile: {}, campuses: {} });
    school.campuses[entry.campus] = {
      verified: entry.verified,
      source: entry.source,
      sourceUrl: entry.sourceUrl || "",
      updatedAt: new Date().toISOString().slice(0, 10),
      verifyCount: entry.verifyCount,
      sections: { dormitory: entry.fields },
    };
  }
  return { generatedAt: new Date().toISOString(), policy: "每所院校必须注明来源与更新时间；verified=true 才视为已核验。", sections, universities };
}

function escapeSql(v) {
  return String(v ?? "").replace(/'/g, "''");
}

function toSql(acc) {
  const lines = [
    "-- 自动生成的 campus_life INSERT（仅包含合并后的可信/待核验记录）。",
    "PRAGMA foreign_keys = ON;",
  ];
  const cols = [
    "university_name", "campus", "province", "city",
    "roommates", "lights_out", "transport", "bed_desk", "morning_exercise",
    "evening_study", "bathroom", "air_conditioner", "takeout", "canteen", "extra",
    "source", "source_url", "verified", "verify_count", "updated_at",
  ];
  const sqlKey = { roommates: "roommates", lightsOut: "lights_out", transport: "transport", bedDesk: "bed_desk", morningExercise: "morning_exercise", eveningStudy: "evening_study", bathroom: "bathroom", airConditioner: "air_conditioner", takeout: "takeout", canteen: "canteen", note: "extra" };
  for (const entry of acc.values()) {
    const values = [
      entry.name, entry.campus, "", "",
      ...Object.keys(sqlKey).map((k) => entry.fields[k] || ""),
      entry.source, entry.sourceUrl || "", entry.verified ? 1 : 0, entry.verifyCount, new Date().toISOString().slice(0, 10),
    ];
    lines.push(`INSERT INTO campus_life (${cols.join(", ")}) VALUES (${values.map((v) => `'${escapeSql(v)}'`).join(", ")});`);
  }
  return lines.join("\n") + "\n";
}

/* ---------------------------- 主流程 ---------------------------- */

async function main() {
  const existing = normalizeExisting(await readJson(PATH.existing));
  const collegeschat = await readOptional(PATH.collegeschat);
  const sushe = await readOptional(PATH.sushe);
  const submissions = await readOptional(PATH.submissions);

  const acc = new Map();

  // 已有数据先作为基线（保留其 profile / campus）。
  for (const [name, entry] of Object.entries(existing.universities)) {
    for (const [campus, c] of Object.entries(entry.campuses || {})) {
      const fields = c?.sections?.dormitory || {};
      if (!Object.values(fields).some((v) => v !== "" && v != null)) continue;
      addRecord(acc, {
        name,
        campus,
        fields,
        source: c.source || "已有数据",
        sourceUrl: c.sourceUrl || "",
      });
    }
  }

  const asRecords = (list, source) => list.map((r) => mapRecord(r, source)).filter(Boolean);
  for (const rec of asRecords(collegeschat, "CollegesChat")) addRecord(acc, rec);
  for (const rec of asRecords(sushe, "sushe.help")) addRecord(acc, rec);
  for (const rec of asRecords(submissions, "投稿")) addRecord(acc, rec, { fromSubmission: true });

  for (const entry of acc.values()) applyCrossVerification(entry);

  const out = toOutput(acc, SECTIONS);

  await mkdir(dirname(resolve(root, PATH.out)), { recursive: true });
  await writeFile(resolve(root, PATH.out), JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`已写入 ${PATH.out}（${acc.size} 个「院校 + 校区」记录）`);

  if (PATH.sql) {
    await writeFile(resolve(root, PATH.sql), toSql(acc), "utf8");
    console.log(`已写入 ${PATH.sql}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
