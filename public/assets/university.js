/**
 * 院校详情页：展示院校基本信息 + 「宿舍条件」卡片。
 * 宿舍卡片与分数/位次推荐完全解耦，数据源：./data/university-info.json。
 */

import { hasDormData, renderDormCard, renderDormEmpty } from "./dorm-card.js";

const $ = (selector, scope = document) => scope.querySelector(selector);

const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );

const tagClass = (tag) => {
  if (tag.includes("985")) return "tag tag-985";
  if (tag.includes("211")) return "tag tag-211";
  if (tag.includes("双一流") || tag.includes("双高")) return "tag tag-syl";
  return "tag";
};

function parseTags(tags) {
  return String(tags || "")
    .split(/[,，、|\/]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function renderTags(tags) {
  const list = parseTags(tags);
  if (!list.length) return "";
  return `<span class="tags">${list.map((t) => `<span class="${tagClass(t)}">${escapeHtml(t)}</span>`).join("")}</span>`;
}

function buildResultsHref(name) {
  return `./results.html?${new URLSearchParams({ university: name }).toString()}`;
}

function buildSubmitHref(name = "") {
  return name ? `./submit.html?${new URLSearchParams({ university: name }).toString()}` : "./submit.html";
}

function renderProfile(profile) {
  if (!profile) return "";
  const meta = [
    profile.province,
    profile.city,
    profile.type,
    profile.nature,
    profile.code ? `院校代码 ${profile.code}` : null,
  ]
    .filter(Boolean)
    .map((t) => `<span class="pill">${escapeHtml(t)}</span>`)
    .join("");
  return `<div class="summary-bar">${meta}</div>`;
}

function renderHero(name, entry) {
  const profile = entry?.profile || {};
  return `<section class="school-hero">
    <h1>${escapeHtml(name)} ${renderTags(profile.tags || entry?.tags)}</h1>
    ${renderProfile(profile)}
    <div class="school-hero-actions">
      <a class="btn btn-ghost btn-sm" href="${buildResultsHref(name)}">查看录取数据</a>
      <a class="btn btn-ghost btn-sm" href="${buildSubmitHref(name)}">投稿补充</a>
    </div>
  </section>`;
}

function renderNoData(name) {
  return `<section class="school-hero">
    <h1>${escapeHtml(name)}</h1>
    <div class="school-hero-actions">
      <a class="btn btn-ghost btn-sm" href="${buildResultsHref(name)}">查看录取数据</a>
      <a class="btn btn-ghost btn-sm" href="${buildSubmitHref(name)}">投稿补充</a>
    </div>
  </section>${renderDormEmpty(buildSubmitHref(name))}`;
}

function renderCampuses(name, entry) {
  const campuses = entry?.campuses || {};
  const keys = Object.keys(campuses);
  if (!keys.length) return renderDormEmpty(buildSubmitHref(name));

  const focus = new URLSearchParams(location.search).get("campus") || "";
  const ordered = focus && campuses[focus] ? [focus, ...keys.filter((k) => k !== focus)] : keys;

  return ordered
    .map((campus) => {
      const c = campuses[campus] || {};
      const dorm = c.sections?.dormitory || {};
      const anchorId = `dorm-${encodeURIComponent(campus)}`;
      if (!hasDormData(dorm)) {
        return renderDormEmpty(buildSubmitHref(name)).replace(
          '<section class="card dorm-card" id="dorm">',
          `<section class="card dorm-card" id="${anchorId}">`,
        );
      }
      return renderDormCard({
        campus,
        dorm,
        verified: c.verified,
        source: c.source,
        sourceUrl: c.sourceUrl,
        updatedAt: c.updatedAt,
        verifyCount: c.verifyCount,
      }).replace(
        '<section class="card dorm-card" id="dorm">',
        `<section class="card dorm-card" id="${anchorId}">`,
      );
    })
    .join("");
}

async function main() {
  const params = new URLSearchParams(location.search);
  const name = (params.get("name") || "").trim();
  const target = $("#university-detail");

  if (!name) {
    target.innerHTML = `<section class="card"><div class="empty"><div class="big">🔍</div>
      <p>缺少院校名称参数。</p>
      <p class="small"><a href="./index.html">回到查询页 →</a></p></div></section>`;
    return;
  }

  document.title = `${name} · 院校详情`;

  let info;
  try {
    const res = await fetch("./data/university-info.json", { cache: "force-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    info = await res.json();
  } catch (error) {
    target.innerHTML = `<section class="card"><div class="empty"><div class="big">⚠️</div>
      <p>院校信息加载失败：${escapeHtml(error.message)}</p></div></section>`;
    return;
  }

  const entry = info?.universities?.[name];
  if (!entry) {
    target.innerHTML = renderNoData(name);
    return;
  }

  target.innerHTML = renderHero(name, entry) + renderCampuses(name, entry);
}

main();
