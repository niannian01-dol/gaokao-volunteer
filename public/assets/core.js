/**
 * 共享核心逻辑（纯函数，不依赖 DOM / Node / Cloudflare API）。
 *
 * 三处复用同一份规则，避免"页面算一套、接口算一套"：
 *  1. public/assets/app.js   —— 浏览器端演示模式（无后端时直接算）
 *  2. dev-server.mjs         —— 本地 Node 服务（读 data/*.json）
 *  3. src/worker.js          —— Cloudflare Worker（读 D1）
 *
 * 一分一段数据格式：[[score, cumulativeRank], ...]，按分数从高到低，
 * 语义为"分数 >= score 的考生累计人数"，与各省考试院公布的一致。
 */

/* ------------------------------------------------------------------ */
/* 分档规则                                                             */
/* ------------------------------------------------------------------ */

/**
 * 位次法分档：gap = (历史最低位次 - 考生位次) / max(考生位次, 500)
 *
 *   gap < reachFloor                     -> 不推荐（差距过大，属于"冲不上"）
 *   reachFloor <= gap <= reachMax         -> 冲（往年录取位次比考生位次略靠前）
 *   reachMax < gap <= steadyMax           -> 稳
 *   steadyMax < gap <= safetyCeil         -> 保
 *   gap > safetyCeil                     -> 不推荐（过于保守，浪费志愿）
 *
 * 分母取 max(考生位次, 500) 是为了让高分段（位次几百名）也有一档合理的
 * 绝对跨度，否则 200 名考生的"稳"只会落在 184~224 名这个过窄的区间里。
 */
export const RANK_RULES = {
  reachFloor: -0.3,
  reachMax: -0.08,
  steadyMax: 0.12,
  safetyCeil: 0.45,
  minDenominator: 500,
};

/**
 * 分数法分档（仅在没有一分一段表时兜底）：diff = 考生分数 - 历史最低分
 *   diff < reachFloor      -> 不推荐（差距过大）
 *   reachFloor<=diff<0     -> 冲
 *   0 <= diff <= steadyMax -> 稳
 *   steadyMax < diff <= safetyCeil -> 保
 *   diff > safetyCeil      -> 不推荐（过于保守）
 */
export const SCORE_RULES = {
  reachFloor: -20,
  steadyMax: 12,
  safetyCeil: 30,
};

/** 推荐候选池的位次窗口倍率，用于把 SQL 查询限制在考生位次附近。 */
export const CANDIDATE_WINDOW = {
  lower: 0.7,
  upper: 1.45,
  pad: 500,
  maxCandidates: 3000,
};

export const BUCKETS = [
  { key: "chong", label: "冲", hint: "往年录取位次比你靠前约 8%~30%，放最前面，有希望但需要一点运气" },
  { key: "wen", label: "稳", hint: "往年录取位次与你的位次相当（-8%~+12%），是志愿表的主力" },
  { key: "bao", label: "保", hint: "往年录取位次比你低 12%~45%，用来兜底，避免滑档" },
];

/* ------------------------------------------------------------------ */
/* 一分一段：分数 <-> 位次                                              */
/* ------------------------------------------------------------------ */

/** 兼容 [[score, rank], ...] / [{score, rank}, ...] / 升序或降序输入。 */
export function normalizeSegments(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const item of input) {
    let score;
    let rank;
    if (Array.isArray(item)) {
      score = Number(item[0]);
      rank = Number(item[1]);
    } else if (item && typeof item === "object") {
      score = Number(item.score);
      rank = Number(item.rank ?? item.cumulative_rank);
    }
    if (Number.isFinite(score) && Number.isFinite(rank)) out.push({ score, rank });
  }
  // 统一为按分数升序，方便二分查找。
  out.sort((a, b) => a.score - b.score);
  return out;
}

/** 分数 -> 累计位次（即"全省排多少名"）。 */
export function scoreToRank(segments, score) {
  if (!segments.length || !Number.isFinite(score)) return null;
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (score >= last.score) return last.rank;
  if (score <= first.score) return first.rank;

  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].score === score) return segments[mid].rank;
    if (segments[mid].score < score) lo = mid + 1;
    else hi = mid - 1;
  }
  // 落在两个分数之间：取较低分那一档的累计位次（更保守）。
  const lower = segments[Math.max(0, hi)];
  const upper = segments[Math.min(segments.length - 1, lo)];
  if (!upper) return lower.rank;
  const span = upper.score - lower.score || 1;
  const t = (score - lower.score) / span;
  return Math.round(lower.rank + (upper.rank - lower.rank) * t);
}

/** 位次 -> 分数（返回满足该位次的最高分）。 */
export function rankToScore(segments, rank) {
  if (!segments.length || !Number.isFinite(rank)) return null;
  // segments 按分数升序：下标 0 = 最低分（累计位次最大），末位 = 最高分（位次最小）。
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (rank >= first.rank) return first.score;
  if (rank <= last.rank) return last.score;

  let lo = 0;
  let hi = segments.length - 1;
  let ans = last.score;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    // 位次随分数升高而单调减小，找到"累计位次 <= 目标位次"的最小分数。
    if (segments[mid].rank <= rank) {
      ans = segments[mid].score;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

/* ------------------------------------------------------------------ */
/* 查询过滤 / 排序 / 分页                                                */
/* ------------------------------------------------------------------ */

const text = (v) => (v == null ? "" : String(v));

export function filterRows(rows, query = {}) {
  const { province, year, subject, batch, university, major, keyword } = query;
  const keywordLower = text(keyword).trim().toLowerCase();
  const universityLower = text(university).trim().toLowerCase();
  const majorLower = text(major).trim().toLowerCase();

  return rows.filter((row) => {
    if (province && row.province !== province) return false;
    if (year && Number(row.year) !== Number(year)) return false;
    if (subject && row.subject_category !== subject) return false;
    if (batch && row.batch !== batch) return false;
    if (universityLower && !text(row.university_name).toLowerCase().includes(universityLower)) return false;
    if (majorLower && !text(row.major_name).toLowerCase().includes(majorLower)) return false;
    if (keywordLower) {
      const haystack = `${text(row.university_name)} ${text(row.major_name)} ${text(row.university_city)}`.toLowerCase();
      if (!haystack.includes(keywordLower)) return false;
    }
    return true;
  });
}

export const SORT_OPTIONS = [
  { key: "rank", label: "最低位次从高到低" },
  { key: "score", label: "最低分从高到低" },
  { key: "score_asc", label: "最低分从低到高" },
  { key: "university", label: "院校名称" },
  { key: "plan", label: "招生计划数" },
];

export function sortRows(rows, sortKey = "rank") {
  const copy = rows.slice();
  const rankOf = (r) => (Number.isFinite(r.min_rank) && r.min_rank > 0 ? r.min_rank : Number.MAX_SAFE_INTEGER);
  const scoreOf = (r) => (Number.isFinite(r.min_score) ? r.min_score : -1);
  switch (sortKey) {
    case "score":
      copy.sort((a, b) => scoreOf(b) - scoreOf(a) || rankOf(a) - rankOf(b));
      break;
    case "score_asc":
      copy.sort((a, b) => scoreOf(a) - scoreOf(b) || rankOf(a) - rankOf(b));
      break;
    case "university":
      copy.sort((a, b) => text(a.university_name).localeCompare(text(b.university_name), "zh-Hans-CN"));
      break;
    case "plan":
      copy.sort((a, b) => Number(b.plan_count || 0) - Number(a.plan_count || 0));
      break;
    case "rank":
    default:
      copy.sort((a, b) => rankOf(a) - rankOf(b));
      break;
  }
  return copy;
}

export function paginate(rows, page = 1, pageSize = 20) {
  const total = rows.length;
  const size = Math.max(1, Number(pageSize) || 20);
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Number(page) || 1), pageCount);
  const start = (current - 1) * size;
  return {
    total,
    page: current,
    pageSize: size,
    pageCount,
    hasPrev: current > 1,
    hasNext: current < pageCount,
    rows: rows.slice(start, start + size),
  };
}

/** 结果页的一次性数据访问：过滤 -> 排序 -> 分页。 */
export function queryRows(rows, query = {}) {
  const filtered = filterRows(rows, query);
  const sorted = sortRows(filtered, query.sort || "rank");
  return {
    ...paginate(sorted, query.page, query.pageSize),
    universityCount: new Set(sorted.map((r) => r.university_name)).size,
    batches: [...new Set(sorted.map((r) => r.batch))],
  };
}

/* ------------------------------------------------------------------ */
/* 冲稳保推荐                                                           */
/* ------------------------------------------------------------------ */

/** 把一条录取记录分到冲/稳/保；返回 null 表示差距过大不推荐。 */
export function classify(row, ctx) {
  if (ctx.basis === "rank") {
    const denominator = Math.max(ctx.userRank, RANK_RULES.minDenominator);
    const gap = (Number(row.min_rank) - ctx.userRank) / denominator;
    if (!Number.isFinite(gap)) return null;
    if (gap < RANK_RULES.reachFloor || gap > RANK_RULES.safetyCeil) return null;
    if (gap <= RANK_RULES.reachMax) return "chong";
    if (gap <= RANK_RULES.steadyMax) return "wen";
    return "bao";
  }
  const diff = ctx.userScore - Number(row.min_score);
  if (!Number.isFinite(diff) || diff < SCORE_RULES.reachFloor || diff > SCORE_RULES.safetyCeil) return null;
  if (diff < 0) return "chong";
  if (diff <= SCORE_RULES.steadyMax) return "wen";
  return "bao";
}

/** 同一所院校聚合成一张卡片，便于"按学校推荐"。 */
export function groupByUniversity(rows, { majorsPerSchool = 4 } = {}) {
  const map = new Map();
  for (const row of rows) {
    const key = row.university_name;
    if (!map.has(key)) {
      map.set(key, {
        university_name: row.university_name,
        university_code: row.university_code,
        university_city: row.university_city,
        university_province: row.university_province,
        university_tags: row.university_tags || "",
        batch: row.batch,
        year: row.year,
        min_score: row.min_score,
        max_score: row.min_score,
        min_rank: row.min_rank,
        max_rank: row.min_rank,
        plan_total: 0,
        majors: [],
        majorCount: 0,
      });
    }
    const school = map.get(key);
    school.majorCount += 1;
    school.plan_total += Number(row.plan_count || 0);
    if (Number(row.min_score) < Number(school.min_score)) school.min_score = row.min_score;
    if (Number(row.min_score) > Number(school.max_score)) school.max_score = row.min_score;
    const rank = Number(row.min_rank);
    if (Number.isFinite(rank)) {
      if (!Number.isFinite(school.min_rank) || rank < school.min_rank) school.min_rank = rank;
      if (!Number.isFinite(school.max_rank) || rank > school.max_rank) school.max_rank = rank;
    }
    school.majors.push({
      major_name: row.major_name,
      major_code: row.major_code,
      group_code: row.group_code,
      subject_requirement: row.subject_requirement,
      min_score: row.min_score,
      min_rank: row.min_rank,
      plan_count: row.plan_count,
    });
  }

  const schools = [...map.values()];
  for (const school of schools) {
    school.majors.sort((a, b) => Number(a.min_rank || Infinity) - Number(b.min_rank || Infinity));
    school.majorCount = school.majors.length;
    school.topMajors = school.majors.slice(0, majorsPerSchool);
    delete school.majors;
  }
  // 卡片排序：越靠前 = 往年录取位次越靠前 = 学校越好。
  schools.sort((a, b) => Number(a.min_rank || Infinity) - Number(b.min_rank || Infinity));
  return schools;
}

/** 推荐候选池的位次上下界。 */
export function candidateWindow(userRank) {
  const { lower, upper, pad } = CANDIDATE_WINDOW;
  return {
    minRank: Math.max(1, Math.floor(userRank * lower - pad)),
    maxRank: Math.ceil(userRank * upper + pad),
  };
}

/**
 * 生成冲/稳/保三档推荐。
 * @param {object} params
 * @param {Array}  params.rows      已按省份/年份/科类/批次过滤的录取记录
 * @param {number} [params.userRank] 考生位次
 * @param {number} [params.userScore] 考生分数
 * @param {Array}  [params.segments] 一分一段表，用于分数<->位次换算
 * @param {number} [params.perBucket] 每档最多返回多少条原始记录
 */
export function buildRecommendations({ rows, userRank, userScore, segments = [], perBucket = 600 } = {}) {
  const segs = normalizeSegments(segments);
  let rank = Number.isFinite(userRank) && userRank > 0 ? Math.round(userRank) : null;
  let score = Number.isFinite(userScore) ? Math.round(userScore) : null;

  if (rank == null && score != null && segs.length) rank = scoreToRank(segs, score);
  if (score == null && rank != null && segs.length) score = rankToScore(segs, rank);

  const basis = rank != null ? "rank" : score != null ? "score" : null;
  if (!basis) {
    return { basis: null, input: { score, rank }, buckets: emptyBuckets(), candidateCount: 0 };
  }

  const ctx = { basis, userRank: rank, userScore: score };
  const candidates = filterRows(rows, { province: undefined }); // 仅用于演示调用方已过滤的场景
  const pool = candidates.length ? candidates : rows;

  const grouped = { chong: [], wen: [], bao: [] };
  for (const row of pool) {
    const key = classify(row, ctx);
    if (!key) continue;
    grouped[key].push(row);
  }

  const buckets = {};
  for (const meta of BUCKETS) {
    const list = sortRows(grouped[meta.key], "rank").slice(0, perBucket);
    buckets[meta.key] = {
      ...meta,
      total: grouped[meta.key].length,
      rows: list,
      schools: groupByUniversity(list, { majorsPerSchool: 4 }),
    };
  }

  return {
    basis,
    input: { score, rank },
    rules: basis === "rank" ? RANK_RULES : SCORE_RULES,
    candidateCount: pool.length,
    buckets,
  };
}

function emptyBuckets() {
  const buckets = {};
  for (const meta of BUCKETS) buckets[meta.key] = { ...meta, total: 0, rows: [], schools: [] };
  return buckets;
}

/* ------------------------------------------------------------------ */
/* 展示辅助                                                             */
/* ------------------------------------------------------------------ */

export function parseTags(tags) {
  return text(tags)
    .split(/[,，、|\/]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return n.toLocaleString("zh-CN");
}

/** 从录取记录里推导筛选器选项，保证只有真实存在的省份/科类/批次。 */
export function deriveMeta(rows, base = {}) {
  const provinces = new Set();
  const years = new Set();
  const batches = new Set();
  const subjectsByProvince = {};

  for (const row of rows) {
    if (!row.province) continue;
    provinces.add(row.province);
    if (row.year) years.add(Number(row.year));
    if (row.batch) batches.add(row.batch);
    const list = (subjectsByProvince[row.province] ||= new Set());
    if (row.subject_category) list.add(row.subject_category);
  }

  const normalize = (value, fallback) => {
    if (!value) return fallback;
    return Array.isArray(value) ? value : [...value];
  };

  return {
    provinces: normalize(base.provinces?.length ? base.provinces : provinces, []),
    years: normalize(base.years?.length ? base.years : years, []).sort((a, b) => b - a),
    batches: normalize(base.batches?.length ? base.batches : batches, []),
    subjectsByProvince: base.subjectsByProvince?.江苏
      ? base.subjectsByProvince
      : Object.fromEntries(Object.entries(subjectsByProvince).map(([k, v]) => [k, [...v]])),
  };
}
