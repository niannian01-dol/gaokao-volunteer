/**
 * 假数据模型（占位数据，等真实 Excel 到位后整体替换）。
 *
 * 生成思路：
 *  1. 每个"省份 × 科类 × 年份"配一条一分一段曲线（累计位次随分数单调变化）。
 *  2. 每所院校有一个"基准分"（以 2024 江苏物理类为坐标原点），
 *     加上省份难度差、科类差、年份差、专业冷热差，得到该专业的最低分。
 *  3. 最低位次由最低分在该省一分一段表中反查得到，保证分数与位次自洽。
 *
 * 曲线模型：rank(s) = min( logistic(s), logLinear(s) )
 *  - logistic 负责中低分段（保证位次收敛到考生总数）
 *  - logLinear 负责高分段（真实一分一段表在头部衰减得比 logistc 快得多）
 */

import { scoreToRank, normalizeSegments } from "../../public/assets/core.js";

export const YEARS = [2024, 2023];

export const PROVINCES = [
  {
    name: "江苏",
    subjects: ["物理类", "历史类"],
    // 相对江苏物理类的分数难度差
    scoreShift: 0,
  },
  { name: "广东", subjects: ["物理类", "历史类"], scoreShift: 4 },
  { name: "河南", subjects: ["理科", "文科"], scoreShift: 10, subjectShift: { 文科: -19 } },
  { name: "四川", subjects: ["理科", "文科"], scoreShift: 6, subjectShift: { 文科: -20 } },
  { name: "山东", subjects: ["综合"], scoreShift: 5 },
];

export const BATCHES = ["提前批", "本科批", "专科批"];

/** 科类相对"物理类/理科"的分数差。 */
export const SUBJECT_SHIFT = { 物理类: 0, 理科: 0, 综合: 0, 历史类: -14, 文科: -18 };

/** 年份整体难度波动。 */
const YEAR_SHIFT = { 2024: 0, 2023: -4 };

/**
 * 一分一段曲线参数（占位，替换为真实一分一段表时整段删除即可）。
 * total: 该省该科类考生总数
 * mu/k : logistic 中段参数
 * topScore/topRank/b : 高分段 log-linear 参数
 */
export const SEGMENT_MODELS = {
  江苏: {
    物理类: { total: 205000, mu: 552.3, k: 28.1, topScore: 730, topRank: 5, b: 0.092 },
    历史类: { total: 130000, mu: 463.0, k: 36.6, topScore: 700, topRank: 5, b: 0.1 },
  },
  广东: {
    物理类: { total: 450000, mu: 453.9, k: 53.1, topScore: 720, topRank: 5, b: 0.085 },
    历史类: { total: 300000, mu: 390.5, k: 48.6, topScore: 690, topRank: 5, b: 0.09 },
  },
  河南: {
    理科: { total: 570000, mu: 450.0, k: 48.0, topScore: 720, topRank: 5, b: 0.085 },
    文科: { total: 250000, mu: 439.3, k: 37.2, topScore: 690, topRank: 3, b: 0.095 },
  },
  四川: {
    理科: { total: 370000, mu: 482.5, k: 45.5, topScore: 700, topRank: 5, b: 0.088 },
    文科: { total: 200000, mu: 473.8, k: 25.1, topScore: 660, topRank: 3, b: 0.09 },
  },
  山东: {
    综合: { total: 600000, mu: 426.2, k: 53.2, topScore: 710, topRank: 5, b: 0.088 },
  },
};

/** 年份微调：2023 年整体偏难一点。 */
function segmentModel(province, subject, year) {
  const base = SEGMENT_MODELS[province]?.[subject];
  if (!base) return null;
  const drift = year === 2024 ? 0 : -3;
  const totalScale = year === 2024 ? 1 : 0.98;
  return {
    ...base,
    mu: base.mu + drift,
    total: Math.round(base.total * totalScale),
    topScore: base.topScore + drift,
  };
}

/** 生成某省某科类某年的一分一段表（750 -> 200，逐分）。 */
export function buildSegments(province, subject, year, { maxScore = 750, minScore = 200 } = {}) {
  const model = segmentModel(province, subject, year);
  if (!model) return [];
  const rows = [];
  for (let s = maxScore; s >= minScore; s -= 1) {
    const logistic = model.total / (1 + Math.exp((s - model.mu) / model.k));
    const logLinear = model.topRank * Math.exp(model.b * (model.topScore - s));
    rows.push([s, Math.max(1, Math.round(Math.min(logistic, logLinear)))]);
  }
  // 分数下降 -> 累计位次不得减少
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i][1] < rows[i - 1][1]) rows[i][1] = rows[i - 1][1];
  }
  return rows;
}

/** 本科批/专科批的参考分数线（用于兜底，避免出现不合理分数）。 */
const BATCH_FLOOR = {
  江苏: { 本科批: 462, 专科批: 220 },
  广东: { 本科批: 442, 专科批: 200 },
  河南: { 本科批: 465, 专科批: 190 },
  四川: { 本科批: 459, 专科批: 150 },
  山东: { 本科批: 444, 专科批: 150 },
};

/**
 * 院校库。base = 2024 江苏物理类的最低分参考值，其余省份按 scoreShift 平移。
 * tags 用于页面打标，batches 决定该校出现在哪些批次。
 */
export const SCHOOLS = [
  { name: "清华大学", code: "10003", province: "北京", city: "北京", tags: "985,211,双一流", base: 686, medical: true },
  { name: "北京大学", code: "10001", province: "北京", city: "北京", tags: "985,211,双一流", base: 684, medical: true },
  { name: "复旦大学", code: "10246", province: "上海", city: "上海", tags: "985,211,双一流", base: 676, medical: true },
  { name: "上海交通大学", code: "10248", province: "上海", city: "上海", tags: "985,211,双一流", base: 675, medical: true },
  { name: "浙江大学", code: "10335", province: "浙江", city: "杭州", tags: "985,211,双一流", base: 670, medical: true },
  { name: "中国人民大学", code: "10002", province: "北京", city: "北京", tags: "985,211,双一流", base: 668 },
  { name: "中国科学技术大学", code: "10358", province: "安徽", city: "合肥", tags: "985,211,双一流", base: 666 },
  { name: "南京大学", code: "10284", province: "江苏", city: "南京", tags: "985,211,双一流", base: 662, medical: true },
  { name: "北京航空航天大学", code: "10006", province: "北京", city: "北京", tags: "985,211,双一流", base: 648 },
  { name: "同济大学", code: "10247", province: "上海", city: "上海", tags: "985,211,双一流", base: 645, medical: true },
  { name: "武汉大学", code: "10486", province: "湖北", city: "武汉", tags: "985,211,双一流", base: 643, medical: true },
  { name: "华中科技大学", code: "10487", province: "湖北", city: "武汉", tags: "985,211,双一流", base: 641, medical: true },
  { name: "中山大学", code: "10558", province: "广东", city: "广州", tags: "985,211,双一流", base: 640, medical: true },
  { name: "西安交通大学", code: "10698", province: "陕西", city: "西安", tags: "985,211,双一流", base: 638, medical: true },
  { name: "哈尔滨工业大学", code: "10213", province: "黑龙江", city: "哈尔滨", tags: "985,211,双一流", base: 636 },
  { name: "东南大学", code: "10286", province: "江苏", city: "南京", tags: "985,211,双一流", base: 634, medical: true },
  { name: "厦门大学", code: "10384", province: "福建", city: "厦门", tags: "985,211,双一流", base: 632 },
  { name: "天津大学", code: "10056", province: "天津", city: "天津", tags: "985,211,双一流", base: 631 },
  { name: "四川大学", code: "10610", province: "四川", city: "成都", tags: "985,211,双一流", base: 630, medical: true },
  { name: "山东大学", code: "10422", province: "山东", city: "济南", tags: "985,211,双一流", base: 628, medical: true },
  { name: "北京理工大学", code: "10007", province: "北京", city: "北京", tags: "985,211,双一流", base: 625 },
  { name: "电子科技大学", code: "10614", province: "四川", city: "成都", tags: "985,211,双一流", base: 624, medical: true },
  { name: "华南理工大学", code: "10561", province: "广东", city: "广州", tags: "985,211,双一流", base: 622, medical: true },
  { name: "中南大学", code: "10533", province: "湖南", city: "长沙", tags: "985,211,双一流", base: 618, medical: true },
  { name: "湖南大学", code: "10532", province: "湖南", city: "长沙", tags: "985,211,双一流", base: 617 },
  { name: "重庆大学", code: "10611", province: "重庆", city: "重庆", tags: "985,211,双一流", base: 616 },
  { name: "南京航空航天大学", code: "10287", province: "江苏", city: "南京", tags: "211,双一流", base: 613 },
  { name: "南京理工大学", code: "10288", province: "江苏", city: "南京", tags: "211,双一流", base: 611 },
  { name: "苏州大学", code: "10285", province: "江苏", city: "苏州", tags: "211,双一流", base: 608, medical: true },
  { name: "深圳大学", code: "10590", province: "广东", city: "深圳", tags: "省重点", base: 605, medical: true },
  { name: "上海大学", code: "10280", province: "上海", city: "上海", tags: "211,双一流", base: 601, medical: true },
  { name: "郑州大学", code: "10459", province: "河南", city: "郑州", tags: "211,双一流", base: 597, medical: true },
  { name: "西南交通大学", code: "10613", province: "四川", city: "成都", tags: "211,双一流", base: 595 },
  { name: "江南大学", code: "10295", province: "江苏", city: "无锡", tags: "211,双一流", base: 593 },
  { name: "南京邮电大学", code: "10293", province: "江苏", city: "南京", tags: "双一流", base: 590 },
  { name: "广东工业大学", code: "11845", province: "广东", city: "广州", tags: "省重点", base: 588 },
  { name: "河南大学", code: "10475", province: "河南", city: "开封", tags: "双一流", base: 586, medical: true },
  { name: "华中师范大学", code: "10511", province: "湖北", city: "武汉", tags: "211,双一流", base: 600, batches: ["提前批", "本科批"] },
  { name: "国防科技大学", code: "91002", province: "湖南", city: "长沙", tags: "985,211,双一流", base: 640, batches: ["提前批", "本科批"] },
  {
    name: "中国人民公安大学",
    code: "10041",
    province: "北京",
    city: "北京",
    tags: "双一流",
    base: 570,
    batches: ["提前批"],
    only: ["法学", "思想政治教育", "英语", "汉语国际教育", "文化产业管理"],
  },
  { name: "江苏大学", code: "10299", province: "江苏", city: "镇江", tags: "省重点", base: 572, medical: true },
  { name: "成都理工大学", code: "10616", province: "四川", city: "成都", tags: "双一流", base: 570 },
  { name: "扬州大学", code: "11117", province: "江苏", city: "扬州", tags: "省重点", base: 568, medical: true },
  { name: "南京工业大学", code: "10291", province: "江苏", city: "南京", tags: "省重点", base: 566 },
  { name: "山东师范大学", code: "10445", province: "山东", city: "济南", tags: "省重点", base: 564 },
  { name: "河南工业大学", code: "10463", province: "河南", city: "郑州", tags: "省重点", base: 558 },
  { name: "南京工程学院", code: "11276", province: "江苏", city: "南京", tags: "省属本科", base: 540 },
  { name: "常州大学", code: "10292", province: "江苏", city: "常州", tags: "省属本科", base: 536 },
  { name: "广东技术师范大学", code: "10588", province: "广东", city: "广州", tags: "省属本科", base: 530 },
  { name: "河南工程学院", code: "11517", province: "河南", city: "郑州", tags: "省属本科", base: 528 },
  { name: "成都工业学院", code: "11116", province: "四川", city: "成都", tags: "省属本科", base: 525 },
  { name: "南京传媒学院", code: "13687", province: "江苏", city: "南京", tags: "民办", base: 486 },
  { name: "郑州工商学院", code: "13507", province: "河南", city: "郑州", tags: "民办", base: 478 },
  { name: "成都锦城学院", code: "13903", province: "四川", city: "成都", tags: "民办", base: 476 },
  { name: "广东白云学院", code: "10822", province: "广东", city: "广州", tags: "民办", base: 472 },
  { name: "深圳职业技术大学", code: "11113", province: "广东", city: "深圳", tags: "双高计划", base: 505, batches: ["本科批"] },
  { name: "南京信息职业技术学院", code: "13112", province: "江苏", city: "南京", tags: "双高计划", base: 452, batches: ["专科批"] },
  { name: "广东轻工职业技术大学", code: "10833", province: "广东", city: "广州", tags: "双高计划", base: 415, batches: ["专科批"] },
  { name: "河南机电职业学院", code: "13788", province: "河南", city: "郑州", tags: "省属专科", base: 380, batches: ["专科批"] },
];

/** 专业库。delta = 相对院校基准分的冷热分差（分）。 */
export const MAJOR_POOL = [
  { name: "计算机科学与技术", code: "080901", category: "工学", subCategory: "计算机类", degree: "工学学士", delta: 8, requirement: "物理+化学", track: "physics", years: 4 },
  { name: "软件工程", code: "080902", category: "工学", subCategory: "计算机类", degree: "工学学士", delta: 6, requirement: "物理+化学", track: "physics", years: 4 },
  { name: "人工智能", code: "080717T", category: "工学", subCategory: "电子信息类", degree: "工学学士", delta: 7, requirement: "物理+化学", track: "physics", years: 4 },
  { name: "电子信息工程", code: "080701", category: "工学", subCategory: "电子信息类", degree: "工学学士", delta: 5, requirement: "物理+化学", track: "physics", years: 4 },
  { name: "电气工程及其自动化", code: "080601", category: "工学", subCategory: "电气类", degree: "工学学士", delta: 3, requirement: "物理+化学", track: "physics", years: 4 },
  { name: "自动化", code: "080801", category: "工学", subCategory: "自动化类", degree: "工学学士", delta: 2, requirement: "物理+化学", track: "physics", years: 4 },
  { name: "机械工程", code: "080201", category: "工学", subCategory: "机械类", degree: "工学学士", delta: -3, requirement: "物理+化学", track: "physics", years: 4 },
  { name: "土木工程", code: "081001", category: "工学", subCategory: "土木类", degree: "工学学士", delta: -12, requirement: "物理+化学", track: "physics", years: 4 },
  { name: "材料科学与工程", code: "080401", category: "工学", subCategory: "材料类", degree: "工学学士", delta: -9, requirement: "物理+化学", track: "physics", years: 4 },
  { name: "化学工程与工艺", code: "081301", category: "工学", subCategory: "化工与制药类", degree: "工学学士", delta: -8, requirement: "物理+化学", track: "physics", years: 4 },
  { name: "临床医学", code: "100201K", category: "医学", subCategory: "临床医学类", degree: "医学学士", delta: 4, requirement: "物理+化学", track: "physics", years: 5 },
  { name: "口腔医学", code: "100301K", category: "医学", subCategory: "口腔医学类", degree: "医学学士", delta: 6, requirement: "物理+化学", track: "physics", years: 5 },
  { name: "数学与应用数学", code: "070101", category: "理学", subCategory: "数学类", degree: "理学学士", delta: 2, requirement: "物理", track: "physics", years: 4 },
  { name: "生物科学", code: "071001", category: "理学", subCategory: "生物科学类", degree: "理学学士", delta: -7, requirement: "物理+化学", track: "physics", years: 4 },
  { name: "金融学", code: "020301K", category: "经济学", subCategory: "金融学类", degree: "经济学学士", delta: 3, requirement: "不限", track: "both", years: 4 },
  { name: "会计学", code: "120203K", category: "管理学", subCategory: "工商管理类", degree: "管理学学士", delta: 1, requirement: "不限", track: "both", years: 4 },
  { name: "法学", code: "030101K", category: "法学", subCategory: "法学类", degree: "法学学士", delta: 2, requirement: "不限", track: "both", years: 4 },
  { name: "英语", code: "050201", category: "文学", subCategory: "外国语言文学类", degree: "文学学士", delta: -4, requirement: "不限", track: "both", years: 4 },
  { name: "新闻传播学类", code: "0503", category: "文学", subCategory: "新闻传播学类", degree: "文学学士", delta: -6, requirement: "不限", track: "both", years: 4 },
  { name: "国际经济与贸易", code: "020401", category: "经济学", subCategory: "经济与贸易类", degree: "经济学学士", delta: -5, requirement: "不限", track: "both", years: 4 },
  { name: "工商管理类", code: "1202", category: "管理学", subCategory: "工商管理类", degree: "管理学学士", delta: -5, requirement: "不限", track: "both", years: 4 },
  { name: "护理学", code: "101101K", category: "医学", subCategory: "护理学类", degree: "理学学士", delta: -9, requirement: "化学或生物", track: "both", years: 4 },
  { name: "哲学", code: "010101", category: "哲学", subCategory: "哲学类", degree: "哲学学士", delta: -10, requirement: "不限", track: "history", years: 4 },
  { name: "汉语言文学", code: "050101", category: "文学", subCategory: "中国语言文学类", degree: "文学学士", delta: 4, requirement: "不限", track: "history", years: 4 },
  { name: "历史学", code: "060101", category: "历史学", subCategory: "历史学类", degree: "历史学学士", delta: -2, requirement: "不限", track: "history", years: 4 },
  { name: "思想政治教育", code: "030503", category: "法学", subCategory: "马克思主义理论类", degree: "法学学士", delta: -4, requirement: "不限", track: "history", years: 4 },
  { name: "小学教育", code: "040107", category: "教育学", subCategory: "教育学类", degree: "教育学学士", delta: -1, requirement: "不限", track: "history", years: 4 },
  { name: "汉语国际教育", code: "050103", category: "文学", subCategory: "中国语言文学类", degree: "文学学士", delta: -6, requirement: "不限", track: "history", years: 4 },
  { name: "文化产业管理", code: "120210", category: "管理学", subCategory: "工商管理类", degree: "管理学学士", delta: -9, requirement: "不限", track: "history", years: 4 },
];

/**
 * 由院校标签推导院校类型（取最高层次）。
 *   "985,211,双一流" -> 985 ；"211,双一流" -> 211 ；"双一流" -> 双一流 ；其余（双高计划/省重点/省属本科等）-> 普通
 */
export function universityType(tags) {
  const list = String(tags || "").split(/[,，、|\/]+/).map((t) => t.trim());
  if (list.includes("985")) return "985";
  if (list.includes("211")) return "211";
  if (list.includes("双一流")) return "双一流";
  return "普通";
}

/** 由院校标签推导办学性质：标签含「民办」即民办，否则公办。 */
export function universityNature(tags) {
  return String(tags || "").includes("民办") ? "民办" : "公办";
}

const HISTORY_EXTRA = [
  { name: "计算机科学与技术", delta: 4, requirement: "物理+化学", track: "physics", years: 4 },
];

/** 只有开设医学院的院校才会出现这些专业。 */
const MEDICAL_MAJORS = new Set(["临床医学", "口腔医学", "护理学"]);

/* ------------------------------------------------------------------ */
/* 确定性随机                                                           */
/* ------------------------------------------------------------------ */

export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function trackOf(subject) {
  return subject === "历史类" || subject === "文科" ? "history" : "physics";
}

/** 为院校 + 科类挑一组专业（确定性，可复现）。 */
function pickMajors(school, subject, count = 5) {
  const track = trackOf(subject);
  const pool = MAJOR_POOL.filter((m) => {
    if (school.only && !school.only.includes(m.name)) return false;
    if (track === "history" ? m.track === "physics" : m.track === "history") return false;
    if (MEDICAL_MAJORS.has(m.name) && !school.medical) return false;
    return true;
  });
  const rand = mulberry32(hashSeed(`${school.name}|${track}`));
  const scored = pool.map((m) => ({ m, k: rand() }));
  scored.sort((a, b) => a.k - b.k);
  let picked = scored.slice(0, count).map((s) => s.m);

  // 高分段院校保留理工科特色：确保至少 2 个工科/医学专业
  if (!school.only && track === "physics" && school.base >= 600) {
    const strong = MAJOR_POOL.filter(
      (m) => m.track === "physics" && m.delta >= 3 && (!MEDICAL_MAJORS.has(m.name) || school.medical),
    ).slice(0, 4);
    const merged = [...picked];
    for (const m of strong) {
      if (merged.length >= count + 1) break;
      if (!merged.some((x) => x.name === m.name)) merged.push(m);
    }
    picked = merged.slice(0, count + 1);
  }
  return picked.sort((a, b) => b.delta - a.delta);
}

function planCountOf(school, rand) {
  if (school.batches?.includes("专科批")) return 40 + Math.floor(rand() * 120);
  if (school.base >= 660) return 3 + Math.floor(rand() * 15);
  if (school.base >= 620) return 8 + Math.floor(rand() * 30);
  if (school.base >= 560) return 20 + Math.floor(rand() * 60);
  if (school.base >= 500) return 30 + Math.floor(rand() * 90);
  return 15 + Math.floor(rand() * 50);
}

function tuitionOf(school, major) {
  if (school.tags.includes("民办")) return 18000 + Math.round((hashSeed(school.name + major.name) % 12) * 800);
  if (school.batches?.includes("专科批")) return 5000 + (hashSeed(school.name + major.name) % 4) * 300;
  if (major.name.includes("医学") || major.years === 5) return 6800;
  return 4800 + (hashSeed(school.name + major.name) % 8) * 200;
}

/** 生成全部录取记录。 */
export function generateAdmissions() {
  const rows = [];
  let id = 0;

  for (const province of PROVINCES) {
    for (const subject of province.subjects) {
      for (const year of YEARS) {
        const segments = normalizeSegments(buildSegments(province.name, subject, year));
        if (!segments.length) continue;
        const shift =
          province.scoreShift +
          (SUBJECT_SHIFT[subject] ?? 0) +
          (province.subjectShift?.[subject] ?? 0) +
          (YEAR_SHIFT[year] ?? 0);

        for (const school of SCHOOLS) {
          const batches = school.batches || ["本科批"];
          const majors = pickMajors(school, subject);
          const rand = mulberry32(hashSeed(`${province.name}|${subject}|${year}|${school.name}`));

          for (const batch of batches) {
            const batchShift = batch === "提前批" ? 2 : batch === "专科批" ? 0 : 0;
            majors.forEach((major, index) => {
              const jitter = Math.round((rand() - 0.5) * 6);
              const raw = school.base + shift + major.delta + jitter + batchShift;
              const floor = BATCH_FLOOR[province.name]?.[batch] ?? 150;
              const score = Math.max(floor, Math.min(735, Math.round(raw)));
              const rank = scoreToRank(segments, score);
              id += 1;
              rows.push({
                id,
                province: province.name,
                year,
                subject_category: subject,
                batch,
                university_code: school.code,
                university_name: school.name,
                university_province: school.province,
                university_city: school.city,
                university_tags: school.tags,
                group_code: String(((index % 3) + 1) * 11).padStart(2, "0"),
                major_code: `${school.code.slice(-2)}${String(index + 1).padStart(2, "0")}`,
                major_name: major.name,
                subject_requirement: major.requirement,
                plan_count: planCountOf(school, rand),
                min_score: score,
                min_rank: rank,
                avg_score: Math.min(735, score + 4 + Math.round(rand() * 5)),
                tuition: tuitionOf(school, major),
                duration: `${major.years}年`,
                remark: batch === "提前批" ? "需政审/面试，以院校招生章程为准" : "",
              });
            });
          }
        }
      }
    }
  }

  return rows;
}

/** 所有省份 × 科类 × 年份的一分一段表。 */
export function generateSegments() {
  const out = {};
  for (const province of PROVINCES) {
    out[province.name] = {};
    for (const subject of province.subjects) {
      out[province.name][subject] = {};
      for (const year of YEARS) {
        out[province.name][subject][String(year)] = buildSegments(province.name, subject, year);
      }
    }
  }
  return out;
}

export { HISTORY_EXTRA };
