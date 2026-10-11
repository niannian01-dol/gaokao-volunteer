/**
 * 前端主逻辑：查询页 / 结果页 / 推荐页共用。
 *
 * 数据来源有两种，接口形状完全一致：
 *   1. 服务端模式：/api/*（本地 dev-server.mjs 或 Cloudflare Worker + D1）
 *   2. 本地演示模式：接口不可用时直接读取 data/*.json，在浏览器内计算
 */

import {
  buildRecommendations,
  filterRows,
  formatNumber,
  normalizeSegments,
  parseTags,
  queryRows,
  SORT_OPTIONS,
} from "./core.js";

/* ------------------------------ 小工具 ------------------------------ */

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

const tagClass = (tag) => {
  if (tag.includes("985")) return "tag tag-985";
  if (tag.includes("211")) return "tag tag-211";
  if (tag.includes("双一流") || tag.includes("双高")) return "tag tag-syl";
  return "tag";
};

function renderTags(tags) {
  const list = parseTags(tags);
  if (!list.length) return "";
  return `<span class="tags">${list.map((t) => `<span class="${tagClass(t)}">${escapeHtml(t)}</span>`).join("")}</span>`;
}

const renderLoading = (target, message = "加载中…") => {
  target.innerHTML = `<div class="loading"><span class="spinner"></span><div>${escapeHtml(message)}</div></div>`;
};

/* ------------------------------ URL 状态 ------------------------------ */

const FILTER_KEYS = ["province", "year", "subject", "batch", "university", "major", "keyword", "sort", "page", "pageSize"];
const EXTRA_KEYS = ["mode", "score", "rank"];

function readQuery() {
  const out = {};
  for (const [key, value] of new URLSearchParams(location.search).entries()) {
    if (value !== "") out[key] = value;
  }
  return out;
}

function buildHref(page, query) {
  const params = new URLSearchParams();
  for (const key of [...FILTER_KEYS, ...EXTRA_KEYS]) {
    const value = query[key];
    if (value === undefined || value === null || value === "") continue;
    if (key === "page" && String(value) === "1") continue;
    params.set(key, value);
  }
  const qs = params.toString();
  return `./${page}${qs ? `?${qs}` : ""}`;
}

const pickFilters = (source) => {
  const out = {};
  for (const key of FILTER_KEYS) if (source[key]) out[key] = source[key];
  return out;
};

/** 院校详情页链接。 */
const universityHref = (name) => `./university.html?${new URLSearchParams({ name }).toString()}`;

/* --------------------- 接口客户端（带本地降级） --------------------- */

const localCache = {};

async function loadLocal(name) {
  if (!localCache[name]) {
    const res = await fetch(`./data/${name}`, { cache: "force-cache" });
    if (!res.ok) throw new Error(`无法加载 ./data/${name}`);
    localCache[name] = await res.json();
  }
  return localCache[name];
}

/** 省份 -> 数据文件名前缀（以后加省份在这里加一行即可）。 */
const PROVINCE_SLUG = { 浙江: "zhejiang" };

const provinceSlug = (province) => PROVINCE_SLUG[province] || encodeURIComponent(province);

/**
 * 把"字典 + 索引行"的压缩数据还原成普通记录数组。
 * 每年一个文件，避免一次性拉几十 MB 把手机拖死；生成方式见 scripts/export-static.mjs。
 */
function expandAdmission(payload) {
  const subjects = payload.subjects || [];
  const batches = payload.batches || [];
  const universities = payload.universities || [];
  const majors = payload.majors || [];
  const rows = payload.rows || [];
  return rows.map((r) => {
    const u = universities[r[0]] || [];
    const m = majors[r[1]] || [];
    const row = {
      id: r[7],
      province: payload.province,
      year: payload.year,
      subject_category: subjects[r[2]],
      batch: batches[r[3]],
      university_code: u[0],
      university_name: u[1],
      university_province: u[2],
      university_city: u[3],
      university_type: u[4],
      university_nature: u[5],
      university_tags: u[6],
      major_code: m[0],
      major_name: m[1],
      major_category: m[2],
      major_sub_category: m[3],
      major_degree: m[4],
      min_score: r[4] === null ? undefined : r[4],
      min_rank: r[5] === null ? undefined : r[5],
      plan_count: r[6] === null ? undefined : r[6],
    };
    for (const key of Object.keys(row)) if (row[key] === undefined || row[key] === "") delete row[key];
    return row;
  });
}

/** 按省份 + 年份加载录取数据（一年一个文件）。 */
async function loadAdmission(province, year) {
  const meta = await loadLocal("meta.json");
  const p = province || meta.provinces?.[0];
  const y = String(year || meta.years?.[0] || "");
  const file = meta.files?.[y] || `data/admission-${provinceSlug(p)}-${y}.json`;
  const key = `admission:${file}`;
  if (!localCache[key]) {
    const res = await fetch(`./${file}`, { cache: "force-cache" });
    if (!res.ok) throw new Error(`无法加载 ./${file}`);
    localCache[key] = expandAdmission(await res.json());
  }
  return localCache[key];
}

function markLocalMode() {
  if (document.body.dataset.mode === "local") return;
  document.body.dataset.mode = "local";
  const notice = $("#mode-notice");
  if (notice) {
    notice.hidden = false;
    notice.textContent = "静态数据模式：页面自带数据文件，全部计算在你的浏览器里完成，无需后端。";
  }
}

/**
 * 底部说明跟着数据源走：
 * 接口报 dataset=d1（本地服务读的是 D1 里的真实数据）就写真实数据量，
 * 否则沿用假数据的提示文案，避免页面明明是真数据还写着"占位假数据"。
 */
function updateDataSourceNote(meta) {
  const note = $("#data-source-note");
  if (!note) return;
  const stats = meta?.stats || {};
  if (meta?.dataset === "d1") {
    const provinces = (meta.provinces || []).join("/") || "—";
    note.textContent =
      `数据来自 D1 数据库：${formatNumber(stats.admissionRows)} 条录取记录 · ` +
      `${formatNumber(stats.universities)} 所院校 · ${formatNumber(stats.majors)} 个专业（${provinces}）。`;
  } else if (meta?.dataset === "static") {
    const provinces = (meta.provinces || []).join("/") || "—";
    note.textContent =
      `真实数据：${formatNumber(stats.admissionRows)} 条录取记录 · ` +
      `${formatNumber(stats.universities)} 所院校 · ${formatNumber(stats.majors)} 个专业（${provinces}）。` +
      String(meta.warning || "");
  } else if (meta?.warning) {
    note.textContent = String(meta.warning);
  }
}

async function apiGet(route, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, value);
  }
  try {
    const res = await fetch(`/api/${route}${search.size ? `?${search}` : ""}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.error) throw new Error(String(data.error));
    return data;
  } catch {
    markLocalMode();
    return localApi(route, params);
  }
}

async function localApi(route, params) {
  if (route === "meta") {
    const meta = await loadLocal("meta.json");
    return { ...meta, stats: { ...(meta.stats || {}) } };
  }
  if (route === "query") {
    const rows = await loadAdmission(params.province, params.year);
    return {
      source: "static",
      ...queryRows(rows, {
        ...params,
        year: params.year ? Number(params.year) : undefined,
        page: Number(params.page || 1),
        pageSize: Number(params.pageSize || 20),
      }),
    };
  }
  if (route === "recommend") {
    const meta = await loadLocal("meta.json");
    const province = params.province || meta.provinces?.[0];
    const year = String(params.year || meta.years?.[0] || "");
    const subject = params.subject || meta.subjectsByProvince?.[province]?.[0] || "";
    const [rows, segments] = await Promise.all([
      loadAdmission(province, year),
      loadLocal("score-segments.json"),
    ]);
    const result = buildRecommendations({
      rows: filterRows(rows, { province, year, subject, batch: params.batch }),
      userScore: params.score ? Number(params.score) : null,
      userRank: params.rank ? Number(params.rank) : null,
      segments: normalizeSegments(segments?.[province]?.[subject]?.[year] || []),
      perBucket: 600,
    });
    return { source: "static", ...result, buckets: shapeBuckets(result.buckets) };
  }
  throw new Error(`未知接口 ${route}`);
}

/** 去掉 buckets 里的原始行，只保留聚合后的学校卡片。 */
function shapeBuckets(buckets) {
  const out = {};
  for (const [key, bucket] of Object.entries(buckets)) {
    out[key] = { ...bucket };
    delete out[key].rows;
  }
  return out;
}

/* --------------------------- 筛选表单 --------------------------- */

const BATCH_ORDER = ["提前批", "本科批", "专科批"];

function fillSelect(select, values, { placeholder, keep } = {}) {
  if (!select) return;
  const current = keep ?? select.value;
  const options = [];
  if (placeholder) options.push(`<option value="">${escapeHtml(placeholder)}</option>`);
  for (const value of values) options.push(`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`);
  select.innerHTML = options.join("");
  if (current && values.map(String).includes(String(current))) select.value = current;
}

const sortBatches = (batches) =>
  [...batches].sort((a, b) => {
    const ia = BATCH_ORDER.indexOf(a);
    const ib = BATCH_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

function syncSubjectOptions(meta, form, prefer) {
  const province = form.province?.value || "";
  const subjects = meta.subjectsByProvince?.[province] || [];
  fillSelect(form.subject, subjects, { placeholder: subjects.length > 1 ? "全部科类" : undefined, keep: prefer });
  if (subjects.length === 1) form.subject.value = subjects[0];
}

function populateFilters(meta, form, initial = {}) {
  fillSelect(form.province, meta.provinces || [], { placeholder: "全部省份", keep: initial.province });
  fillSelect(form.year, (meta.years || []).map(String), { placeholder: "全部年份", keep: initial.year });
  fillSelect(form.batch, sortBatches(meta.batches || []), { placeholder: "全部批次", keep: initial.batch });
  if (initial.province) form.province.value = initial.province;
  syncSubjectOptions(meta, form, initial.subject);
  for (const key of ["university", "major", "keyword"]) {
    if (initial[key] && form[key]) form[key].value = initial[key];
  }
}

function readForm(form) {
  const out = {};
  for (const key of ["province", "year", "subject", "batch", "university", "major", "keyword"]) {
    const el = form[key];
    if (!el) continue;
    const value = el.value.trim();
    if (value) out[key] = value;
  }
  return out;
}

function renderSummary(target, query) {
  if (!target) return;
  const parts = [];
  if (query.province) parts.push(query.province);
  if (query.year) parts.push(`${query.year}年`);
  if (query.subject) parts.push(query.subject);
  if (query.batch) parts.push(query.batch);
  if (query.university) parts.push(`院校含“${query.university}”`);
  if (query.major) parts.push(`专业含“${query.major}”`);
  if (query.keyword) parts.push(`关键词“${query.keyword}”`);
  target.innerHTML = (parts.length ? parts : ["全部数据"]).map((p) => `<span class="pill">${escapeHtml(p)}</span>`).join("");
}

/* --------------------------- 最近查询 --------------------------- */

const HISTORY_KEY = "gaokao.history.v1";

function readHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function pushHistory(query) {
  const label =
    [query.province, query.year && `${query.year}年`, query.subject, query.batch].filter(Boolean).join(" · ") ||
    "全部数据";
  const entry = { label, query: pickFilters(query), ts: Date.now() };
  const list = readHistory().filter((item) => JSON.stringify(item.query) !== JSON.stringify(entry.query));
  list.unshift(entry);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 6)));
  } catch {
    /* 隐私模式下忽略 */
  }
}

function renderHistory(target) {
  if (!target) return;
  const list = readHistory();
  const card = target.closest(".card");
  if (card) card.hidden = list.length === 0;
  target.innerHTML = list
    .map((item) => `<a class="pill" href="${buildHref("results.html", item.query)}">${escapeHtml(item.label)}</a>`)
    .join("");
}

/* --------------------------- 查询页 --------------------------- */

async function initQueryPage() {
  const form = $("#query-form");
  if (!form) return;
  const meta = await apiGet("meta");
  populateFilters(meta, form, {});
  form.province.addEventListener("change", () => syncSubjectOptions(meta, form));
  updateDataSourceNote(meta);

  const stats = meta.stats || {};
  const setText = (id, value) => {
    const el = $(id);
    if (el && value != null) el.textContent = formatNumber(value);
  };
  setText("#stat-rows", stats.admissionRows);
  setText("#stat-schools", stats.universities);
  setText("#stat-majors", stats.majors);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = readForm(form);
    pushHistory(query);
    location.href = buildHref("results.html", query);
  });

  $("#reset-btn")?.addEventListener("click", () => {
    form.reset();
    syncSubjectOptions(meta, form);
  });

  const toRecommend = $("#to-recommend");
  if (toRecommend) {
    toRecommend.addEventListener("click", (event) => {
      event.preventDefault();
      location.href = buildHref("recommend.html", readForm(form));
    });
  }

  renderHistory($("#history-list"));
}

/* --------------------------- 结果页 --------------------------- */

function renderRows(rows, query) {
  if (!rows.length) {
    return `<tr><td colspan="7"><div class="empty"><div class="big">🔍</div>
      <p>没有符合条件的录取记录</p>
      <p class="small">可以试试放宽批次、更换年份，或只保留省份条件。</p>
      <p class="small"><a href="./recommend.html?${new URLSearchParams(pickFilters(query)).toString()}">改用冲稳保推荐 →</a></p>
    </div></td></tr>`;
  }
  return rows
    .map(
      (row) => `
      <tr>
        <td class="cell-school" data-label="院校">
          <div class="name"><a class="school-name-link" href="${universityHref(row.university_name)}">${escapeHtml(row.university_name)}</a><a class="dorm-link" href="${universityHref(row.university_name)}#dorm">宿舍</a> ${renderTags(row.university_tags)}</div>
          <div class="loc">${escapeHtml(row.university_province || "")}${row.university_city ? ` · ${escapeHtml(row.university_city)}` : ""} · 院校代码 ${escapeHtml(row.university_code || "—")}</div>
        </td>
        <td class="cell-major" data-label="专业">
          <div class="name">${escapeHtml(row.major_name)}</div>
          <div class="req">${
            [
              row.subject_requirement ? `选科 ${escapeHtml(row.subject_requirement)}` : null,
              row.group_code ? `专业组 ${escapeHtml(row.group_code)}` : null,
              row.duration ? escapeHtml(row.duration) : null,
              row.major_category ? `门类 ${escapeHtml(row.major_category)}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "—"
          }</div>
        </td>
        <td data-label="批次">${escapeHtml(row.year)} 年 · ${escapeHtml(row.batch)}</td>
        <td class="num" data-label="最低分"><span class="strong-score">${escapeHtml(row.min_score)}</span></td>
        <td class="num" data-label="最低位次">${formatNumber(row.min_rank)}</td>
        <td class="num" data-label="招生计划">${formatNumber(row.plan_count)}</td>
        <td class="num" data-label="学费">${formatNumber(row.tuition)}</td>
      </tr>`,
    )
    .join("");
}

async function initResultsPage() {
  const table = $("#result-body");
  if (!table) return;

  const meta = await apiGet("meta");
  updateDataSourceNote(meta);
  const query = readQuery();
  const form = $("#filter-form");
  populateFilters(meta, form, query);
  form.province.addEventListener("change", () => syncSubjectOptions(meta, form));

  const sortSelect = $("#sort-select");
  sortSelect.innerHTML = SORT_OPTIONS.map(
    (option) => `<option value="${option.key}">${escapeHtml(option.label)}</option>`,
  ).join("");
  sortSelect.value = query.sort || "rank";

  const pageSizeSelect = $("#pagesize-select");
  pageSizeSelect.value = query.pageSize || "20";

  renderSummary($("#summary"), query);

  const panel = $("#filter-panel");
  const toggle = $("#toggle-filter");
  toggle?.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    toggle.textContent = panel.hidden ? "修改筛选条件" : "收起筛选条件";
  });
  if (Object.keys(pickFilters(query)).length > 2) panel.hidden = true;

  async function load(page = 1) {
    renderLoading($("#result-meta"), "正在查询…");
    table.innerHTML = "";
    const data = await apiGet("query", {
      ...pickFilters(query),
      sort: sortSelect.value,
      page,
      pageSize: pageSizeSelect.value,
    });
    table.innerHTML = renderRows(data.rows || [], query);
    $("#result-meta").innerHTML = data.total
      ? `<span class="pill">共 <b>${formatNumber(data.total)}</b> 条记录</span>
         <span class="pill">涉及 <b>${formatNumber(data.universityCount)}</b> 所院校</span>
         <span class="pill">第 <b>${data.page}</b> / ${data.pageCount} 页</span>
         ${data.source === "local" ? '<span class="pill">本地演示数据</span>' : ""}`
      : "";
    $("#pager").innerHTML = data.total
      ? `<button class="btn btn-ghost btn-sm" id="prev-page" ${data.hasPrev ? "" : "disabled"}>上一页</button>
         <span class="info">第 ${data.page} / ${data.pageCount} 页</span>
         <button class="btn btn-ghost btn-sm" id="next-page" ${data.hasNext ? "" : "disabled"}>下一页</button>`
      : "";
    $("#prev-page")?.addEventListener("click", () => load(data.page - 1));
    $("#next-page")?.addEventListener("click", () => load(data.page + 1));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const next = { ...readForm(form), sort: sortSelect.value, pageSize: pageSizeSelect.value };
    pushHistory(next);
    history.replaceState(null, "", buildHref("results.html", next));
    for (const key of Object.keys(query)) delete query[key];
    Object.assign(query, pickFilters(next));
    renderSummary($("#summary"), query);
    panel.hidden = true;
    if (toggle) toggle.textContent = "修改筛选条件";
    load(1);
  });

  sortSelect.addEventListener("change", () => load(1));
  pageSizeSelect.addEventListener("change", () => load(1));

  load(Number(query.page || 1));
}

/* --------------------------- 推荐页 --------------------------- */

function renderSchoolCard(school, query, bucketKey) {
  const rankRange =
    school.min_rank === school.max_rank
      ? formatNumber(school.min_rank)
      : `${formatNumber(school.min_rank)} ~ ${formatNumber(school.max_rank)}`;
  const scoreRange =
    school.min_score === school.max_score ? String(school.min_score) : `${school.min_score} ~ ${school.max_score}`;
  const majors = school.topMajors || [];
  const more = school.majorCount > majors.length ? `<span class="major-chip">其余 ${school.majorCount - majors.length} 个专业…</span>` : "";
  return `
    <article class="school-card">
      <div class="head">
        <div>
          <h3><a class="school-name-link" href="${universityHref(school.university_name)}">${escapeHtml(school.university_name)}</a> ${renderTags(school.university_tags)}</h3>
          <div class="loc">${escapeHtml(school.university_province || "")}${school.university_city ? ` · ${escapeHtml(school.university_city)}` : ""} · ${escapeHtml(school.batch)} · ${escapeHtml(school.year)} 年</div>
        </div>
        <span class="pill" data-bucket="${bucketKey}">${escapeHtml(BUCKET_LABEL[bucketKey])}</span>
      </div>
      <div class="metrics">
        <div class="metric"><span class="k">最低分</span><span class="v">${escapeHtml(scoreRange)}</span></div>
        <div class="metric"><span class="k">最低位次</span><span class="v">${rankRange}</span></div>
        <div class="metric"><span class="k">可报专业</span><span class="v">${majors.length ? school.majorCount : 0}</span></div>
      </div>
      <div class="major-chips">
        ${majors
          .map(
            (m) =>
              `<span class="major-chip">${escapeHtml(m.major_name)} <b>${escapeHtml(m.min_score)}</b>分 / ${formatNumber(m.min_rank)}位</span>`,
          )
          .join("")}
        ${more}
      </div>
      <div class="card-foot">
        <a class="btn btn-ghost btn-sm" href="${universityHref(school.university_name)}#dorm">宿舍条件</a>
        <a class="btn btn-ghost btn-sm" href="${buildHref("results.html", { ...query, university: school.university_name })}">查看该校全部专业</a>
      </div>
    </article>`;
}

const BUCKET_LABEL = { chong: "冲", wen: "稳", bao: "保" };

function renderBuckets(data, query) {
  const target = $("#bucket-area");
  const order = ["chong", "wen", "bao"];
  const buckets = data.buckets || {};
  const tabs = order
    .map(
      (key) => `<button class="bucket-tab" data-bucket="${key}">
        <span class="label">${BUCKET_LABEL[key]}</span>
        <span class="count">${formatNumber(buckets[key]?.total || 0)} 个专业</span>
      </button>`,
    )
    .join("");

  const panels = order
    .map((key) => {
      const bucket = buckets[key] || { schools: [], total: 0, hint: "" };
      const schools = bucket.schools || [];
      return `<section class="bucket-panel" data-bucket="${key}">
        <div class="bucket-hint" data-bucket="${key}"><span>${escapeHtml(bucket.hint || "")}</span></div>
        ${
          schools.length
            ? `<div class="school-list">${schools.map((s) => renderSchoolCard(s, query, key)).join("")}</div>`
            : `<div class="empty"><div class="big">📭</div><p>该档没有匹配的院校</p><p class="small">可以调整分数/位次或放宽批次条件。</p></div>`
        }
      </section>`;
    })
    .join("");

  target.innerHTML = `<div class="bucket-tabs">${tabs}</div>${panels}`;

  const activate = (key) => {
    $$(".bucket-tab", target).forEach((el) => el.classList.toggle("is-active", el.dataset.bucket === key));
    $$(".bucket-panel", target).forEach((el) => el.classList.toggle("is-active", el.dataset.bucket === key));
  };
  $$(".bucket-tab", target).forEach((el) => el.addEventListener("click", () => activate(el.dataset.bucket)));
  activate("wen");
}

async function initRecommendPage() {
  const form = $("#recommend-form");
  if (!form) return;

  const meta = await apiGet("meta");
  updateDataSourceNote(meta);
  const query = readQuery();
  populateFilters(meta, form, query);
  form.province.addEventListener("change", () => syncSubjectOptions(meta, form));

  let mode = query.mode === "rank" ? "rank" : "score";
  const modeButtons = $$("[data-mode]");
  const input = $("#value-input");
  const label = $("#value-label");
  const hint = $("#value-hint");

  const applyMode = (next, keepValue) => {
    mode = next;
    modeButtons.forEach((el) => el.classList.toggle("is-active", el.dataset.mode === next));
    label.textContent = next === "score" ? "你的高考分数" : "你的全省位次";
    input.placeholder = next === "score" ? "例如 600" : "例如 30000";
    input.inputMode = "numeric";
    hint.textContent =
      next === "score"
        ? "填分数时，会用该省一分一段表自动换算成位次再分档。"
        : "位次来自一分一段表，跨年份比较更稳定，推荐优先用位次。";
    if (!keepValue) input.value = next === "score" ? query.score || "600" : query.rank || "30000";
  };
  modeButtons.forEach((el) => el.addEventListener("click", () => applyMode(el.dataset.mode, false)));
  applyMode(mode, false);

  const resultArea = $("#recommend-result");

  async function run() {
    const filters = readForm(form);
    const raw = input.value.trim();
    if (!raw) {
      input.focus();
      return;
    }
    const next = { ...filters, mode };
    if (mode === "score") next.score = raw;
    else next.rank = raw;
    pushHistory(filters);
    history.replaceState(null, "", buildHref("recommend.html", next));
    renderSummary($("#recommend-summary"), filters);
    renderLoading(resultArea, "正在计算冲稳保…");
    const data = await apiGet("recommend", next);
    resultArea.innerHTML = "";
    if (!data.basis) {
      resultArea.innerHTML = `<div class="empty"><div class="big">⚠️</div><p>无法换算位次</p><p class="small">该省份/年份缺少一分一段表，请改用位次输入。</p></div>`;
      return;
    }
    const basisText = data.basis === "rank" ? "按位次分档" : "按分数分档";
    const conv =
      data.input.score && data.input.rank
        ? `分数 ${data.input.score} ≈ 位次 ${formatNumber(data.input.rank)}`
        : data.basis === "rank"
          ? `位次 ${formatNumber(data.input.rank)}`
          : `分数 ${data.input.score}`;
    const note = $("#recommend-note");
    if (note) {
      note.innerHTML = `<div class="notice">${escapeHtml(basisText)} · ${escapeHtml(conv)} · 候选 ${formatNumber(
        data.candidateCount,
      )} 条记录${data.source === "local" ? " · 本地演示数据" : ""}</div>`;
    }
    renderBuckets(data, { ...filters, mode, [mode]: raw });
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run();
  });

  if (query.score || query.rank) run();
  else renderSummary($("#recommend-summary"), query);
}

/* --------------------------- 启动 --------------------------- */

function highlightNav() {
  const page = location.pathname.split("/").pop() || "index.html";
  $$("[data-nav]").forEach((el) => el.classList.toggle("is-active", el.dataset.nav === page));
}

async function main() {
  highlightNav();
  try {
    await Promise.all([initQueryPage(), initResultsPage(), initRecommendPage()]);
  } catch (error) {
    console.error(error);
    const target = $("#query-form, #result-body, #recommend-form");
    if (target) target.insertAdjacentHTML("afterend", `<div class="notice">页面初始化失败：${escapeHtml(error.message)}</div>`);
  }
}

main();
