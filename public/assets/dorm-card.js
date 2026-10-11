/**
 * 宿舍条件卡片组件（纯渲染，无副作用）。
 *
 * 与分数 / 位次 / 专业推荐完全解耦：只关心一个「院校 + 校区」的宿舍信息。
 * 由 university.js 挂载到院校详情页。
 */

export const DORM_FIELDS = [
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

const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );

/** 该校区是否有任何宿舍字段。 */
export function hasDormData(dorm) {
  return Object.values(dorm || {}).some((v) => String(v ?? "").trim() !== "");
}

function renderValue(value, kind) {
  const text = String(value ?? "").trim();
  if (!text) return '<span class="info-missing">—</span>';
  if (kind === "yesno") {
    const cls = /^是/.test(text) ? "info-yes" : /^否/.test(text) ? "info-no" : "";
    return `<span class="${cls}">${escapeHtml(text)}</span>`;
  }
  return escapeHtml(text);
}

function renderProvenance({ verified, source, sourceUrl, updatedAt }) {
  const badge = verified
    ? '<span class="pill provenance-verified">已核验</span>'
    : '<span class="pill provenance-unverified">未核验 · 仅供参考</span>';
  const sourceText = sourceUrl
    ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(source)}</a>`
    : escapeHtml(source);
  const bits = [badge];
  if (updatedAt) bits.push(`<span class="pill">更新于 ${escapeHtml(updatedAt)}</span>`);
  if (source) bits.push(`<span class="pill">来源：${sourceText}</span>`);
  return `<div class="summary-bar provenance-bar">${bits.join("")}</div>`;
}

/**
 * 渲染一张宿舍卡片。
 * @param {object} data { campus, dorm, verified, source, sourceUrl, updatedAt, verifyCount }
 */
export function renderDormCard(data = {}) {
  const dorm = data.dorm || {};
  if (!hasDormData(dorm)) return "";

  const cells = DORM_FIELDS.map(
    (f) => `<div class="dorm-cell">
      <div class="dorm-label">${escapeHtml(f.label)}</div>
      <div class="dorm-value">${renderValue(dorm[f.key], f.kind)}</div>
    </div>`,
  ).join("");

  return `<section class="card dorm-card" id="dorm">
    <div class="card-title">
      <h2>🛏️ 宿舍条件${data.campus ? ` <span class="campus-chip">${escapeHtml(data.campus)}</span>` : ""}</h2>
    </div>
    ${renderProvenance(data)}
    <div class="dorm-grid">${cells}</div>
    <div class="dorm-foot">
      以上信息来自在校生 / 毕业生分享或公开资料，仅供参考，请以学校官方发布为准。
    </div>
  </section>`;
}

/** 无宿舍数据时的占位卡片，露出投稿入口。 */
export function renderDormEmpty(submitHref = "./submit.html") {
  return `<section class="card dorm-card" id="dorm">
    <div class="empty">
      <div class="big">🛏️</div>
      <p><b>暂无宿舍信息</b></p>
      <p class="small">欢迎在校生投稿补充，帮助学弟学妹了解真实情况。</p>
      <a class="btn btn-primary btn-sm" style="margin-top: 14px" href="${escapeHtml(submitHref)}">我去投稿</a>
    </div>
    <div class="dorm-foot">
      投稿信息经「同校区双源一致」交叉核验后才会标记为可信，仅供参考。
    </div>
  </section>`;
}
