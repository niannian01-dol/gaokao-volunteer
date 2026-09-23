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
 *   3) node scripts/verify-d1.mjs
 */

import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../src/worker.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 递归找出 wrangler 本地 D1 的 SQLite 文件（体积最大的那个就是主库）。 */
function findLocalD1() {
  const base = join(root, ".wrangler", "state", "v3", "d1");
  let best = null;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".sqlite")) {
        const size = statSync(full).size;
        if (!best || size > best.size) best = { path: full, size };
      }
    }
  };
  try {
    walk(base);
  } catch {
    return null;
  }
  return best?.path || null;
}

/** 把 node:sqlite 包装成 Worker 期望的 D1 接口（prepare/bind/all/first/run/batch）。 */
/** 优先读写方式打开（SQLite 打开 WAL 库需要写权限），只读文件系统上退回只读模式。 */
function openDatabase(dbFile) {
  try {
    return new DatabaseSync(dbFile);
  } catch {
    return new DatabaseSync(dbFile, { readOnly: true });
  }
}

function createD1(dbFile) {
  const db = openDatabase(dbFile);
  const run = (sql, params) => {
    const stmt = db.prepare(sql);
    const isRead = /^\s*(select|with|pragma)/i.test(sql);
    if (isRead) {
      const results = stmt.all(...params);
      return { results, success: true, meta: { rows_read: results.length } };
    }
    const info = stmt.run(...params);
    return { results: [], success: true, meta: { changes: info.changes } };
  };

  const prepare = (sql) => {
    const make = (params) => ({
      bind: (...next) => make(next),
      all: async () => run(sql, params),
      first: async (column) => {
        const { results } = run(sql, params);
        const row = results[0] ?? null;
        return column && row ? row[column] : row;
      },
      run: async () => run(sql, params),
    });
    return make([]);
  };

  return { prepare, batch: async (statements) => Promise.all(statements.map((s) => s.all())) };
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  [OK]  " : "  [FAIL]"} ${name}${detail ? ` —— ${detail}` : ""}`);
}

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

  console.log("2) /api/query 按省份+年份+科类+批次查询并按位次排序");
  const q = await call(
    "/api/query?province=%E6%B1%9F%E8%8B%8F&year=2024&subject=%E7%89%A9%E7%90%86%E7%B1%BB&batch=%E6%9C%AC%E7%A7%91%E6%89%B9&sort=rank&page=1&pageSize=5",
  );
  const rows = q.body.rows || [];
  check("查到数据", q.body.total > 0, `total=${q.body.total} 院校数=${q.body.universityCount}`);
  check("关联到了院校所在城市", rows.every((r) => r.university_city), rows.map((r) => `${r.university_name}/${r.university_city}`).join(" "));
  check("最低分/最低位次都是整数", rows.every((r) => Number.isInteger(r.min_score) && Number.isInteger(r.min_rank)), rows.map((r) => `${r.min_score}分/${r.min_rank}位`).join(" "));
  check("按位次升序", rows.every((r, i) => i === 0 || rows[i - 1].min_rank <= r.min_rank));
  console.log(`     样例：${rows[0] ? `${rows[0].university_name} ${rows[0].major_name} ${rows[0].min_score}分 ${rows[0].min_rank}位（${rows[0].university_province}${rows[0].university_city}，${rows[0].university_type}、${rows[0].university_nature}）` : "无"}\n`);

  console.log("3) /api/query 关键词搜索（院校名/专业名/城市/院校代码）");
  const kw = await call("/api/query?keyword=%E8%8B%8F%E5%B7%9E&pageSize=3");
  check("按城市/院校名能搜到", kw.body.total > 0, `total=${kw.body.total} 首个=${kw.body.rows?.[0]?.university_name || "无"}\n`);

  console.log("4) /api/recommend 用分数换算位次后输出冲/稳/保");
  const byScore = await call("/api/recommend?province=%E6%B1%9F%E8%8B%8F&year=2024&subject=%E7%89%A9%E7%90%86%E7%B1%BB&score=600");
  check("用上了一分一段表", byScore.body.hasSegments === true);
  check("给出换算后的位次", Number.isFinite(byScore.body.basis === "rank" ? byScore.body.input?.rank : NaN), JSON.stringify(byScore.body.input));
  const buckets = byScore.body.buckets || {};
  check("冲/稳/保三档都有结果", ["chong", "wen", "bao"].every((k) => buckets[k]?.total > 0), ["chong", "wen", "bao"].map((k) => `${buckets[k]?.label || k}=${buckets[k]?.total ?? 0}`).join(" "));
  check("每档都聚合出了院校", ["chong", "wen", "bao"].every((k) => (buckets[k]?.schools || []).length > 0), ["chong", "wen", "bao"].map((k) => `${k}院校${buckets[k]?.schools?.length ?? 0}所`).join(" "));

  console.log("\n5) /api/recommend 直接给位次");
  const byRank = await call("/api/recommend?province=%E6%B1%9F%E8%8B%8F&year=2024&subject=%E7%89%A9%E7%90%86%E7%B1%BB&rank=30000");
  const b2 = byRank.body.buckets || {};
  check("按位次也能分档", ["chong", "wen", "bao"].every((k) => b2[k]?.total > 0), ["chong", "wen", "bao"].map((k) => `${b2[k]?.label || k}=${b2[k]?.total ?? 0}`).join(" "));

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
