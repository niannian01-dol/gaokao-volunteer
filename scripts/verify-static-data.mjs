/**
 * 静态真数据校验：不联网、不需要任何账号，检查 public/data 里的数据是否完整可用。
 *
 * 背景：仓库里的 public/data/*.json 是「浙江省 2017–2025 真实录取数据」，
 * 由 scripts/export-static.mjs 从 D1 导出，不是 scripts/build-data.mjs 生成的假数据。
 * 所以这里不重新生成数据，而是直接读仓库里的文件，逐项确认：
 *   1) meta.json 的 dataset / 省份 / 年份等基本字段正常
 *   2) 每个年份文件都能解析，结构是「字典 + 行索引」压缩格式，且索引不越界、字段类型正确
 *   3) 各行加起来的总数、院校数、专业数与 meta.stats 里的统计一致
 *   4) 一分一段表条数与 meta.stats.segmentRows 一致
 *   5) 页面和它们引用的本地资源都存在（防止只提交了数据、忘了提交页面）
 *   6) 就读体验数据 public/data/university-info.json 的字段都符合 sections 声明
 *
 * 用法：node scripts/verify-static-data.mjs
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(repoRoot, "public", "data");

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  console.log(`${ok ? "  [OK]  " : "  [FAIL]"} ${name}${detail ? ` —— ${detail}` : ""}`);
}

function readJson(relPath) {
  const full = join(repoRoot, relPath);
  if (!existsSync(full)) throw new Error(`文件不存在：${relPath}`);
  const text = readFileSync(full, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${relPath} 不是合法 JSON：${error.message}`);
  }
}

const isInt = (v) => Number.isInteger(v);
const fmt = (n) => n.toLocaleString("en-US");

function main() {
  console.log("\n静态真数据校验（public/data）");

  /* ---------------------------------------------------------------- */
  /* 1) meta.json                                                      */
  /* ---------------------------------------------------------------- */
  const meta = readJson("public/data/meta.json");
  console.log("\n1) meta.json 基本字段");
  check("dataset 是 static（不是假数据演示）", meta.dataset === "static", `dataset=${meta.dataset}`);
  check("province / year 列表非空", Array.isArray(meta.provinces) && meta.provinces.length > 0 && Array.isArray(meta.years) && meta.years.length > 0,
    `${meta.provinces?.join("、")} · ${meta.years?.length} 个年份`);
  check("stats 里有 admissionRows / universities / majors", isInt(meta.stats?.admissionRows) && isInt(meta.stats?.universities) && isInt(meta.stats?.majors));
  check("files 与 years 一一对应", JSON.stringify(Object.keys(meta.files ?? {}).sort()) === JSON.stringify((meta.years ?? []).map(String).sort()));

  /* ---------------------------------------------------------------- */
  /* 2) 逐年录取数据                                                   */
  /* ---------------------------------------------------------------- */
  console.log("\n2) 逐年录取数据文件");
  const allUniversities = new Set();
  const allMajors = new Set();
  const allIds = new Set();
  let totalRows = 0;
  let badStructure = null;
  let badRow = null;
  let duplicateId = null;

  for (const year of (meta.years ?? []).map(String).sort()) {
    const rel = meta.files?.[year];
    if (!rel) {
      check(`${year} 年在 meta.files 里有对应文件`, false);
      continue;
    }
    let payload;
    try {
      payload = readJson("public/" + rel);
    } catch (error) {
      check(`${year} 年文件能读取`, false, error.message);
      continue;
    }

    const universities = payload.universities;
    const majors = payload.majors;
    const rows = payload.rows;
    const subjects = payload.subjects;
    const batches = payload.batches;

    if (payload.v !== 1 || String(payload.year) !== year || !Array.isArray(universities) || !Array.isArray(majors) ||
        !Array.isArray(rows) || !Array.isArray(subjects) || !Array.isArray(batches)) {
      badStructure = badStructure ?? `${year} 年：v / year / universities / majors / rows / subjects / batches 结构不对`;
      continue;
    }
    if (typeof payload.province !== "string" || payload.province === "") {
      badStructure = badStructure ?? `${year} 年：province 为空`;
      continue;
    }

    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 8) {
        badRow = badRow ?? `${year} 年：出现列数不足的录取记录`;
        break;
      }
      const [u, m, s, b, score, rank, plan, id] = row;
      if (!isInt(u) || u < 0 || u >= universities.length || !isInt(m) || m < 0 || m >= majors.length ||
          !isInt(s) || s < 0 || s >= subjects.length || !isInt(b) || b < 0 || b >= batches.length ||
          (score !== null && (!isInt(score) || score < 0 || score > 750)) ||
          (rank !== null && (!isInt(rank) || rank < 1)) ||
          (plan !== null && (!isInt(plan) || plan < 0)) || !isInt(id)) {
        badRow = badRow ?? `${year} 年：字段类型或范围不对（院校索引 ${u} / 专业索引 ${m} / 分数 ${score} / 位次 ${rank}）`;
        break;
      }
      if (allIds.has(id)) duplicateId = duplicateId ?? `${year} 年出现重复的 id ${id}`;
      allIds.add(id);
    }

    for (const u of universities) if (u[1]) allUniversities.add(u[1]);
    for (const m of majors) if (m[1]) allMajors.add(m[1]);
    totalRows += rows.length;
    check(`${year} 年  ${rel}`, true, `${fmt(rows.length)} 条 · 院校 ${fmt(universities.length)} 所 · 专业 ${fmt(majors.length)} 个`);
  }

  check("所有年份文件结构一致且字段合法", !badStructure && !badRow, badStructure ?? badRow ?? undefined);
  check("录取记录 id 没有重复", !duplicateId, duplicateId ?? undefined);
  check(`合计 ${fmt(totalRows)} 条与 meta.stats.admissionRows 一致`, totalRows === meta.stats?.admissionRows,
    `文件合计 ${fmt(totalRows)} / meta 记录 ${fmt(meta.stats?.admissionRows ?? 0)}`);
  check(`院校 ${fmt(allUniversities.size)} 所与 meta.stats.universities 一致`, allUniversities.size === meta.stats?.universities);
  check(`专业 ${fmt(allMajors.size)} 个与 meta.stats.majors 一致`, allMajors.size === meta.stats?.majors);

  /* ---------------------------------------------------------------- */
  /* 3) 一分一段表                                                     */
  /* ---------------------------------------------------------------- */
  console.log("\n3) 一分一段表");
  let segmentRows = 0;
  let segmentBad = null;
  try {
    const segments = readJson("public/data/score-segments.json");
    for (const subjectMap of Object.values(segments)) {
      for (const yearMap of Object.values(subjectMap)) {
        for (const list of Object.values(yearMap)) {
          if (!Array.isArray(list)) { segmentBad = segmentBad ?? "出现不是数组的年份数据"; continue; }
          for (const pair of list) {
            if (!Array.isArray(pair) || pair.length < 2 || !isInt(pair[0]) || !isInt(pair[1]) || pair[1] < 1) {
              segmentBad = segmentBad ?? `一分一段出现异常行：${JSON.stringify(pair)}`;
              continue;
            }
            segmentRows += 1;
          }
        }
      }
    }
  } catch (error) {
    segmentBad = error.message;
  }
  check("一分一段表能读取且每行是 [分数, 位次]", !segmentBad, segmentBad ?? undefined);
  check(`共 ${fmt(segmentRows)} 行与 meta.stats.segmentRows 一致`, segmentRows === meta.stats?.segmentRows,
    `实际 ${fmt(segmentRows)} / meta 记录 ${fmt(meta.stats?.segmentRows ?? 0)}`);

  /* ---------------------------------------------------------------- */
  /* 4) 页面与静态资源                                                 */
  /* ---------------------------------------------------------------- */
  console.log("\n4) 页面与静态资源");
  const pages = ["public/index.html", "public/results.html", "public/recommend.html", "public/university.html", "public/submit.html"];
  let missing = null;
  let assetCount = 0;
  for (const page of pages) {
    if (!existsSync(join(repoRoot, page))) { missing = missing ?? `缺少页面 ${page}`; continue; }
    const html = readFileSync(join(repoRoot, page), "utf8");
    for (const m of html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)) {
      const target = m[1].split("#")[0].split("?")[0];
      if (!target.endsWith(".js") && !target.endsWith(".css") && !target.endsWith(".json")) continue;
      const full = resolve(join(repoRoot, page, ".."), target);
      if (!existsSync(full) || !statSync(full).isFile()) { missing = missing ?? `${page} 引用了不存在的 ${target}`; continue; }
      assetCount += 1;
    }
  }
  check("5 个页面都在，且引用的本地 js / css / json 都存在", !missing, missing ?? `共检查 ${assetCount} 个引用`);

  /* ---------------------------------------------------------------- */
  /* 5) 就读体验数据（宿舍条件）                                        */
  /* ---------------------------------------------------------------- */
  console.log("\n5) 就读体验数据 university-info.json");
  let lifeNote = null;
  let campusCount = 0;
  let universityCount = 0;
  if (!existsSync(join(dataDir, "university-info.json"))) {
    check("就读体验数据文件存在", false, "缺少 public/data/university-info.json");
  } else {
    try {
      const life = readJson("public/data/university-info.json");
      const declared = new Set((life.sections ?? []).flatMap((s) => (s.fields ?? []).map((f) => f.key)));
      if (!Array.isArray(life.sections) || life.sections.length === 0) lifeNote = lifeNote ?? "sections 为空";
      if (!life.universities || typeof life.universities !== "object") lifeNote = lifeNote ?? "universities 不是对象";
      for (const [name, entry] of Object.entries(life.universities ?? {})) {
        universityCount += 1;
        for (const [campus, info] of Object.entries(entry.campuses ?? {})) {
          campusCount += 1;
          if (typeof info.verified !== "boolean") lifeNote = lifeNote ?? `${name}/${campus} 缺少 verified`;
          if (!info.source) lifeNote = lifeNote ?? `${name}/${campus} 没有填来源 source`;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(info.updatedAt ?? ""))) lifeNote = lifeNote ?? `${name}/${campus} 的 updatedAt 不是 YYYY-MM-DD`;
          for (const key of Object.keys(info.sections?.dormitory ?? {})) {
            if (!declared.has(key)) lifeNote = lifeNote ?? `${name}/${campus} 用了 sections 里没声明的字段 ${key}`;
          }
        }
      }
    } catch (error) {
      lifeNote = error.message;
    }
    check(`就读体验数据格式正常（${universityCount} 所院校 / ${campusCount} 个校区）`, !lifeNote, lifeNote ?? undefined);
  }

  /* ---------------------------------------------------------------- */
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n共 ${checks.length} 项检查，失败 ${failed.length} 项。`);
  if (failed.length) {
    console.log("失败项：");
    for (const f of failed) console.log(`  - ${f.name}`);
    console.log("\n静态真数据校验未通过。");
    process.exit(1);
  }
  console.log("静态真数据（录取数据 + 一分一段 + 页面资源）校验通过。");
}

try {
  main();
} catch (error) {
  console.error(`\n[FAIL] 校验中断：${error.message}`);
  process.exit(1);
}
