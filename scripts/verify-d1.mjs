/**
 * 本地验收脚本：不联网、不登录 Cloudflare，直接拿 src/worker.js 跑一遍 D1 接口。
 *
 * 原理：wrangler 的 `d1 execute --local` 会把数据写进 .wrangler/state/v3/d1 下的 SQLite
 * 文件，这里用 Node 自带的 node:sqlite 打开它，再套一层 D1 接口的小壳，
 * 于是「线上 Worker 读 D1」这条代码路径就能在本地先验证一遍。
 *
 * 用法：
 *   1) npx wrangler d1 execute gaokao --local --file=./schema/01_schema.sql
 *   2) npx wrangler d1 execute gaokao --local --file=./schema/02_seed.sql
 *      （换成 03_import.sql / 04_segments.sql 就是验真实数据）
 *   3) node scripts/verify-d1.mjs
 *
 * 检查用的省份/年份/科类/批次不写死：先读 /api/meta，再按「优先浙江，其次江苏等」
 * 挑一组库里真实存在的数据，所以换任何省份的真实数据（或继续用假数据）都能直接跑。
 */

import worker from "../src/worker.js";
import { createD1, findLocalD1 } from "./local-d1.mjs";

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  [OK]  " : "  [FAIL]"} ${name}${detail ? ` —— ${detail}` : ""}`);
}

/** 按偏好顺序挑一个库里确实存在的值，挑不到就退回列表第一个。 */
function pick(list, prefers) {
  const items = Array.isArray(list) ? list : [];
  for (const p of prefers) if (items.includes(p)) return p;
  return items[0] ?? null;
}

const qs = (params) =>
  Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");

async function main() {
  const dbFile = findLocalD1();
  if (!dbFile) {
    console.error("没找到本地 D1 数据库，请先执行 schema/01_schema.sql 与 02_seed.sql（--local）。");
    process.exit(1);
  }
  console.log(`本地 D1：${dbFile}\n`);

  const env = {
    DB: createD1(dbFile),
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
  };
  const call = async (path) => {
    const res = await worker.fetch(new Request(`http://localhost${path}`), env);
    return { status: res.status, body: await res.json() };
  };

  console.log("1) /api/meta 筛选器选项");
  const meta = await call("/api/meta");
  check("接口返回 200", meta.status === 200, `status=${meta.status}`);
  check("统计里有院校/专业/记录数", meta.body.stats?.admissionRows > 0, JSON.stringify(meta.body.stats));
  console.log(`     省份=${(meta.body.provinces || []).join("/")} 年份=${(meta.body.years || []).join("/")}\n`);
  if (!meta.body.stats?.admissionRows) {
    console.log("\n库里没有录取记录，先导入数据再验收。");
    process.exit(1);
  }

  // 用库里的实际数据挑一组筛选条件
  const province = pick(meta.body.provinces, ["浙江", "江苏", "山东", "河南", "广东", "四川"]);
  const year = Number((meta.body.years || [])[0]);
  const subject = pick(meta.body.subjectsByProvince?.[province], ["综合", "物理类", "理科", "历史类", "文科"]);
  const base = { province, year, subject };
  console.log(`   本次验收用：${province} / ${year} / ${subject}\n`);

  console.log("2) /api/query 按省份+年份+科类查询并按位次排序");
  const q = await call(`/api/query?${qs({ ...base, sort: "rank", page: 1, pageSize: 5 })}`);
  const rows = q.body.rows || [];
  check("查到数据", q.body.total > 0, `total=${q.body.total} 院校数=${q.body.universityCount}`);
  check(
    "关联到了院校所在城市",
    rows.length > 0 && rows.every((r) => r.university_city),
    rows.map((r) => `${r.university_name}/${r.university_city}`).join(" "),
  );
  check(
    "最低分/最低位次都是整数",
    rows.length > 0 && rows.every((r) => Number.isInteger(r.min_score) && Number.isInteger(r.min_rank)),
    rows.map((r) => `${r.min_score}分/${r.min_rank}位`).join(" "),
  );
  check("按位次升序", rows.every((r, i) => i === 0 || rows[i - 1].min_rank <= r.min_rank));
  console.log(
    `     样例：${rows[0] ? `${rows[0].university_name} ${rows[0].major_name} ${rows[0].min_score}分 ${rows[0].min_rank}位（${rows[0].university_province}${rows[0].university_city}，${rows[0].university_type}、${rows[0].university_nature}，${rows[0].batch}）` : "无"}\n`,
  );

  console.log("3) /api/query 加批次筛选");
  const batch = rows[0]?.batch || null;
  const byBatch = await call(`/api/query?${qs({ ...base, batch, sort: "rank", pageSize: 3 })}`);
  check("批次筛选后仍能查到", byBatch.body.total > 0, `batch=${batch} total=${byBatch.body.total}`);
  check(
    "返回行的批次与筛选一致",
    (byBatch.body.rows || []).every((r) => r.batch === batch),
    (byBatch.body.rows || []).map((r) => r.batch).join(" "),
  );

  console.log("\n4) /api/query 关键词搜索（院校名/专业名/城市/院校代码）");
  const keyword = rows[0]?.university_city || rows[0]?.university_name || province;
  const kw = await call(`/api/query?${qs({ keyword, pageSize: 3 })}`);
  check("关键词能搜到", kw.body.total > 0, `keyword=${keyword} total=${kw.body.total} 首个=${kw.body.rows?.[0]?.university_name || "无"}\n`);

  // 取中段的一条记录当"考生"：分数和位次都是官方公布值，推荐结果必然落在这个年份里
  const pageCount = q.body.pageCount || 1;
  const mid = await call(`/api/query?${qs({ ...base, sort: "rank", page: Math.max(1, Math.round(pageCount / 2)), pageSize: 5 })}`);
  const pivot = (mid.body.rows || [])[0] || rows[0] || {};
  const userScore = pivot.min_score;
  const userRank = pivot.min_rank;
  console.log(`   参考考生：${userScore} 分 / 第 ${userRank} 位（取自 ${pivot.university_name || "库内"} 的官方录取值）\n`);

  console.log("5) /api/recommend 输入分数 -> 冲/稳/保");
  const byScore = await call(`/api/recommend?${qs({ ...base, score: userScore })}`);
  check("用上了一分一段表", byScore.body.hasSegments === true);
  check("把分数换算成了位次", Number.isFinite(byScore.body.input?.rank), JSON.stringify(byScore.body.input));
  const b1 = byScore.body.buckets || {};
  check(
    "冲/稳/保三档都有结果",
    ["chong", "wen", "bao"].every((k) => b1[k]?.total > 0),
    ["chong", "wen", "bao"].map((k) => `${b1[k]?.label || k}=${b1[k]?.total ?? 0}`).join(" "),
  );
  check(
    "每档都聚合出了院校",
    ["chong", "wen", "bao"].every((k) => (b1[k]?.schools || []).length > 0),
    ["chong", "wen", "bao"].map((k) => `${k}院校${b1[k]?.schools?.length ?? 0}所`).join(" "),
  );

  console.log("\n6) /api/recommend 直接给位次");
  const byRank = await call(`/api/recommend?${qs({ ...base, rank: userRank })}`);
  const b2 = byRank.body.buckets || {};
  check(
    "按位次也能分档",
    ["chong", "wen", "bao"].every((k) => b2[k]?.total > 0),
    ["chong", "wen", "bao"].map((k) => `${b2[k]?.label || k}=${b2[k]?.total ?? 0}`).join(" "),
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n共 ${checks.length} 项检查，失败 ${failed.length} 项。`);
  if (failed.length) {
    for (const f of failed) console.log(`  - ${f.name} ${f.detail || ""}`);
    process.exit(1);
  }
  console.log("D1 接口链路（查询 -> 结果 -> 推荐）验证通过。");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
