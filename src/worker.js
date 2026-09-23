/**
 * Cloudflare Worker：与 dev-server.mjs 暴露完全一致的 /api 接口，数据源换成 D1。
 *
 *   GET /api/meta                筛选器选项 + 数据量统计
 *   GET /api/query               按省份/年份/科类/批次/院校/专业分页查询
 *   GET /api/recommend           输入分数或位次，输出冲/稳/保三档院校
 *
 * 分档规则、分数<->位次换算都复用 public/assets/core.js，保证与前端演示模式一致。
 */

import {
  buildRecommendations,
  CANDIDATE_WINDOW,
  candidateWindow,
  normalizeSegments,
  rankToScore,
  scoreToRank,
} from "../public/assets/core.js";

/**
 * 查询用的固定子句。
 * admission_score 只存名称 + 外键，院校所在省份/城市/标签、专业门类这些
 * 维度信息都放在 university / major 表里，查询时按 id 关联回来（Excel 导入时
 * 就算还没回填 id，也能靠名称兜底，见下方 COALESCE）。
 */
const SELECT_COLUMNS = `
  a.id, a.province, a.year, a.subject_category, a.batch,
  a.university_code, a.university_name, a.major_code, a.major_name,
  a.min_score, a.min_rank, a.plan_count,
  COALESCE(u.province, '') AS university_province,
  COALESCE(u.city, '')     AS university_city,
  COALESCE(u.type, '')     AS university_type,
  COALESCE(u.nature, '')   AS university_nature,
  COALESCE(u.tags, '')     AS university_tags,
  COALESCE(m.category, '')     AS major_category,
  COALESCE(m.sub_category, '') AS major_sub_category,
  COALESCE(m.degree, '')       AS major_degree`;

const FROM_SQL = `FROM admission_score a
  LEFT JOIN university u ON u.id = a.university_id OR (a.university_id IS NULL AND u.name = a.university_name)
  LEFT JOIN major      m ON m.id = a.major_id      OR (a.major_id      IS NULL AND m.name = a.major_name)`;

const SORT_SQL = {
  rank: "a.min_rank IS NULL, a.min_rank ASC",
  score: "a.min_score DESC, a.min_rank ASC",
  score_asc: "a.min_score ASC, a.min_rank ASC",
  university: "a.university_name ASC, a.min_rank ASC",
  plan: "a.plan_count DESC",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};

/** 把 query string 翻译成 WHERE 子句 + 绑定参数。 */
function buildWhere(params, { withRankWindow = null } = {}) {
  const clauses = [];
  const binds = [];

  const eq = (column, value) => {
    if (value === null || value === undefined || value === "") return;
    clauses.push(`${column} = ?`);
    binds.push(value);
  };

  eq("a.province", params.get("province"));
  eq("a.year", params.get("year") ? Number(params.get("year")) : null);
  eq("a.subject_category", params.get("subject"));
  eq("a.batch", params.get("batch"));
  eq("a.university_code", params.get("universityCode"));

  const like = (column, value) => {
    if (!value) return;
    clauses.push(`${column} LIKE ?`);
    binds.push(`%${value}%`);
  };
  like("a.university_name", params.get("university"));
  like("a.major_name", params.get("major"));

  const keyword = params.get("keyword");
  if (keyword) {
    clauses.push(
      "(a.university_name LIKE ? OR a.major_name LIKE ? OR a.university_code LIKE ? OR u.city LIKE ? OR u.province LIKE ?)",
    );
    binds.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }

  if (withRankWindow) {
    clauses.push("a.min_rank BETWEEN ? AND ?");
    binds.push(withRankWindow.minRank, withRankWindow.maxRank);
  }

  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", binds };
}

/* ---------------------------- /api/meta ---------------------------- */

let metaCache = null;
let metaCachedAt = 0;
const META_TTL_MS = 5 * 60 * 1000;

async function loadMeta(env) {
  const now = Date.now();
  if (metaCache && now - metaCachedAt < META_TTL_MS) return metaCache;

  const [provinces, subjects, years, batches, counts] = await env.DB.batch([
    env.DB.prepare("SELECT DISTINCT province FROM admission_score ORDER BY province"),
    env.DB.prepare("SELECT DISTINCT province, subject_category FROM admission_score"),
    env.DB.prepare("SELECT DISTINCT year FROM admission_score ORDER BY year DESC"),
    env.DB.prepare("SELECT DISTINCT batch FROM admission_score"),
    env.DB.prepare(
      "SELECT COUNT(*) AS admissionRows, COUNT(DISTINCT university_name) AS universities, COUNT(DISTINCT major_name) AS majors FROM admission_score",
    ),
  ]);

  const subjectsByProvince = {};
  for (const row of subjects.results || []) {
    (subjectsByProvince[row.province] ||= []).push(row.subject_category);
  }

  const stats = counts.results?.[0] || {};
  metaCache = {
    dataset: "d1",
    provinces: (provinces.results || []).map((r) => r.province),
    years: (years.results || []).map((r) => r.year),
    batches: (batches.results || []).map((r) => r.batch),
    subjectsByProvince,
    stats: {
      admissionRows: stats.admissionRows || 0,
      universities: stats.universities || 0,
      majors: stats.majors || 0,
    },
  };
  metaCachedAt = now;
  return metaCache;
}

/* --------------------------- /api/query --------------------------- */

async function handleQuery(env, params) {
  const { sql: where, binds } = buildWhere(params);
  const page = clampInt(params.get("page"), 1, 100000, 1);
  const pageSize = clampInt(params.get("pageSize"), 1, 100, 20);
  const order = SORT_SQL[params.get("sort")] || SORT_SQL.rank;

  const [list, count] = await env.DB.batch([
    env.DB.prepare(
      `SELECT ${SELECT_COLUMNS} ${FROM_SQL} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ).bind(...binds, pageSize, (page - 1) * pageSize),
    env.DB.prepare(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT a.university_name) AS universityCount ${FROM_SQL} ${where}`,
    ).bind(
      ...binds,
    ),
  ]);

  const total = count.results?.[0]?.total || 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return {
    source: "d1",
    total,
    universityCount: count.results?.[0]?.universityCount || 0,
    page,
    pageSize,
    pageCount,
    hasPrev: page > 1,
    hasNext: page < pageCount,
    rows: list.results || [],
  };
}

/* ------------------------- /api/recommend ------------------------- */

async function loadSegments(env, province, year, subject) {
  const { results } = await env.DB.prepare(
    "SELECT score, rank FROM score_segment WHERE province = ? AND year = ? AND subject_category = ? ORDER BY score DESC",
  )
    .bind(province, year, subject)
    .all();
  return normalizeSegments(results || []);
}

async function handleRecommend(env, params) {
  const province = params.get("province") || "江苏";
  const year = clampInt(params.get("year"), 1900, 2999, new Date().getFullYear());
  const subject = params.get("subject") || "物理类";
  const scoreInput = Number(params.get("score"));
  const rankInput = Number(params.get("rank"));

  const segments = await loadSegments(env, province, year, subject);
  let userRank = Number.isFinite(rankInput) && rankInput > 0 ? Math.round(rankInput) : null;
  let userScore = Number.isFinite(scoreInput) && scoreInput > 0 ? Math.round(scoreInput) : null;
  if (userRank == null && userScore != null && segments.length) userRank = scoreToRank(segments, userScore);
  if (userScore == null && userRank != null && segments.length) userScore = rankToScore(segments, userRank);

  if (userRank == null && userScore == null) {
    return json({ error: "missing_input", message: "请提供 score 或 rank 参数" }, 400);
  }

  const window = userRank != null ? candidateWindow(userRank) : null;
  const { sql: where, binds } = buildWhere(params, { withRankWindow: window });
  const { results } = await env.DB.prepare(
    `SELECT ${SELECT_COLUMNS} ${FROM_SQL} ${where} ORDER BY a.min_rank ASC LIMIT ?`,
  )
    .bind(...binds, CANDIDATE_WINDOW.maxCandidates)
    .all();

  const result = buildRecommendations({
    rows: results || [],
    userRank,
    userScore,
    segments,
    perBucket: 300,
  });

  const buckets = {};
  for (const [key, bucket] of Object.entries(result.buckets)) {
    const { rows: _rows, ...rest } = bucket;
    buckets[key] = rest;
  }

  return {
    source: "d1",
    basis: result.basis,
    input: result.input,
    rules: result.rules,
    candidateCount: result.candidateCount,
    hasSegments: segments.length > 0,
    window,
    buckets,
  };
}

/* ------------------------------ 入口 ------------------------------ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "") || "meta";

    try {
      if (route === "meta") return json(await loadMeta(env));
      if (route === "query") return json(await handleQuery(env, url.searchParams));
      if (route === "recommend") return json(await handleRecommend(env, url.searchParams));
      return json({ error: "not_found", message: `未知接口 /api/${route}` }, 404);
    } catch (error) {
      return json({ error: "internal_error", message: String(error?.message || error) }, 500);
    }
  },
};
