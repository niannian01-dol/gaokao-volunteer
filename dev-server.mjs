/**
 * 本地演示服务（零依赖，只用 Node 内置模块）。
 *
 *   node dev-server.mjs            # http://127.0.0.1:8787
 *   node dev-server.mjs --port 9000
 *   node dev-server.mjs --json     # 忽略本地 D1，强制用 data/*.json 里的假数据
 *   node dev-server.mjs --no-api   # 只托管静态页，验证前端离线降级
 *   node dev-server.mjs --lan      # 绑定所有网卡，同一 Wi-Fi 下的手机可访问
 *
 * /api 接口与线上 Cloudflare Worker 完全一致（同一份 src/worker.js）：
 *   - 本地 D1 里导入过数据（.wrangler/state/v3/d1/*.sqlite）就直接读 D1，页面看到真实数据；
 *   - 没导入过则退回 public/data/*.json 假数据，仍能把「查询 -> 结果 -> 推荐」跑通。
 */

import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { networkInterfaces } from "node:os";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRecommendations, deriveMeta, filterRows, queryRows, normalizeSegments } from "./public/assets/core.js";
import { createD1, findLocalD1 } from "./scripts/local-d1.mjs";
import worker from "./src/worker.js";

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, "public");
const dataDir = join(publicDir, "data");

const args = process.argv.slice(2);
const portFlag = args.indexOf("--port");
const PORT = Number(portFlag >= 0 ? args[portFlag + 1] : process.env.PORT || 8787);
/** --lan（等价于 --host 0.0.0.0）：绑定所有网卡，手机连同一个 Wi-Fi 就能访问。 */
const hostFlag = args.indexOf("--host");
const HOST = args.includes("--lan") ? "0.0.0.0" : (hostFlag >= 0 ? args[hostFlag + 1] : process.env.HOST || "127.0.0.1");
/** --no-api：只做静态托管，用来验证"没有后端时前端降级读 data/*.json"这条路径。 */
const NO_API = args.includes("--no-api");
/** --json：忽略本地 D1，强制走 public/data/*.json 的假数据。 */
const FORCE_JSON = args.includes("--json");

/* 数据源选择：本地 D1 优先，其次假数据 JSON。 */
const localD1File = NO_API || FORCE_JSON ? null : findLocalD1();
const DATA_SOURCE = localD1File ? "d1" : "json";
const d1Handler = localD1File ? createD1(localD1File) : null;
const ASSETS_STUB = { fetch: async () => new Response("not found", { status: 404 }) };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

/* ------------------------------------------------------------------ */
/* 数据加载（进程内缓存）                                                */
/* 只在 DATA_SOURCE === "json" 时用到；走 D1 时这些文件根本不读。          */
/* ------------------------------------------------------------------ */

const cache = new Map();

async function loadJson(name) {
  if (!cache.has(name)) {
    const raw = await readFile(join(dataDir, name), "utf8");
    cache.set(name, JSON.parse(raw));
  }
  return cache.get(name);
}

let statsCache = null;
async function loadStats() {
  if (statsCache) return statsCache;
  const [rows, meta] = await Promise.all([loadJson("admission.json"), loadJson("meta.json")]);
  statsCache = {
    admissionRows: rows.length,
    universities: new Set(rows.map((r) => r.university_name)).size,
    majors: new Set(rows.map((r) => r.major_name)).size,
    provinces: meta.provinces.length,
    years: meta.years,
    byProvince: Object.fromEntries(
      meta.provinces.map((p) => [p, rows.filter((r) => r.province === p).length]),
    ),
  };
  return statsCache;
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

function num(params, key) {
  const raw = params.get(key);
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function handleApi(url) {
  /* D1 模式：直接复用 Worker 的接口实现，保证本地和线上行为一致。 */
  if (DATA_SOURCE === "d1") {
    const response = await worker.fetch(new Request(url.href), { DB: d1Handler, ASSETS: ASSETS_STUB });
    return { status: response.status, body: await response.json() };
  }

  const params = url.searchParams;
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "") || "meta";

  if (route === "meta") {
    const meta = await loadJson("meta.json");
    const stats = await loadStats();
    return { status: 200, body: { ...meta, stats: { ...meta.stats, ...stats } } };
  }

  if (route === "query") {
    const rows = await loadJson("admission.json");
    const result = queryRows(rows, {
      province: params.get("province") || undefined,
      year: num(params, "year") || undefined,
      subject: params.get("subject") || undefined,
      batch: params.get("batch") || undefined,
      university: params.get("university") || undefined,
      major: params.get("major") || undefined,
      keyword: params.get("keyword") || undefined,
      sort: params.get("sort") || "rank",
      page: num(params, "page") || 1,
      pageSize: Math.min(100, num(params, "pageSize") || 20),
    });
    return { status: 200, body: { source: "demo", ...result } };
  }

  if (route === "recommend") {
    const rows = await loadJson("admission.json");
    const segmentTables = await loadJson("score-segments.json");
    const province = params.get("province") || "江苏";
    const year = String(num(params, "year") || 2024);
    const subject = params.get("subject") || "物理类";
    const batch = params.get("batch") || undefined;
    const score = num(params, "score");
    const rank = num(params, "rank");

    const filtered = filterRows(rows, { province, year, subject, batch });
    const segments = normalizeSegments(segmentTables?.[province]?.[subject]?.[year] || []);
    const result = buildRecommendations({
      rows: filtered,
      userScore: score,
      userRank: rank,
      segments,
      perBucket: 600,
    });

    const buckets = {};
    for (const [key, bucket] of Object.entries(result.buckets)) {
      const { rows: _rows, ...rest } = bucket;
      buckets[key] = rest;
    }
    return {
      status: 200,
      body: {
        source: "demo",
        basis: result.basis,
        input: result.input,
        rules: result.rules,
        candidateCount: result.candidateCount,
        hasSegments: segments.length > 0,
        buckets,
      },
    };
  }

  return { status: 404, body: { error: "not_found", message: `未知接口 /api/${route}` } };
}

/* ------------------------------------------------------------------ */
/* 静态资源                                                            */
/* ------------------------------------------------------------------ */

async function serveStatic(pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel.endsWith("/")) rel += "index.html";

  const safe = normalize(rel).replace(/^([/\\])+/, "");
  const candidates = [join(publicDir, safe)];

  for (const file of candidates) {
    if (!resolve(file).startsWith(resolve(root) + sep)) continue;
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      const body = await readFile(file);
      return { status: 200, body, type: MIME[extname(file).toLowerCase()] || "application/octet-stream" };
    } catch {
      /* 继续尝试下一个候选路径 */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 服务器                                                              */
/* ------------------------------------------------------------------ */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const started = Date.now();

  try {
    let result;
    if (NO_API && url.pathname.startsWith("/api/")) {
      result = { status: 404, type: "application/json; charset=utf-8", body: { error: "api_disabled" } };
    } else if (url.pathname.startsWith("/api/")) {
      result = await handleApi(url);
      result.type = "application/json; charset=utf-8";
    } else {
      result = await serveStatic(url.pathname);
      if (!result) {
        result = {
          status: 404,
          type: "text/html; charset=utf-8",
          body: Buffer.from(
            '<!doctype html><meta charset="utf-8"><title>404</title><body style="font-family:system-ui;padding:40px"><h1>404</h1><p>页面不存在。<a href="/">返回查询页</a></p>',
          ),
        };
      }
    }

    const payload = Buffer.isBuffer(result.body) ? result.body : Buffer.from(JSON.stringify(result.body));
    const headers = {
      "content-type": result.type,
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    };

    const acceptsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
    const compressible = /json|javascript|text|css|svg/.test(result.type) && payload.length > 1024;
    const body = acceptsGzip && compressible ? gzipSync(payload) : payload;
    if (body !== payload) headers["content-encoding"] = "gzip";
    headers["content-length"] = String(body.length);

    res.writeHead(result.status, headers);
    res.end(body);
    console.log(`${req.method} ${url.pathname}${url.search} -> ${result.status} (${Date.now() - started}ms)`);
  } catch (error) {
    console.error(error);
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "internal_error", message: String(error?.message || error) }));
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`高考志愿查询平台 · 本地演示服务`);
  console.log(`  本机：http://127.0.0.1:${PORT}`);
  if (HOST === "0.0.0.0") {
    for (const list of Object.values(networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family === "IPv4" && !ni.internal) console.log(`  手机：http://${ni.address}:${PORT}`);
      }
    }
  }
  if (DATA_SOURCE === "d1") {
    try {
      const res = await worker.fetch(new Request(`http://127.0.0.1:${PORT}/api/meta`), { DB: d1Handler, ASSETS: ASSETS_STUB });
      const meta = await res.json();
      console.log(`  数据源：D1 本地库 ${localD1File}`);
      console.log(`  数据量：${meta.stats?.admissionRows} 条录取记录 / ${meta.stats?.universities} 所院校 / ${meta.stats?.majors} 个专业`);
      console.log(`  可筛选：省份 ${(meta.provinces || []).join("/")} · 年份 ${(meta.years || []).join("/")}`);
    } catch (error) {
      console.log(`  数据源：D1 读取失败 —— ${error?.message || error}`);
    }
  } else if (NO_API) {
    console.log(`  数据源：纯静态托管（--no-api），页面自己读 data/*.json 假数据`);
  } else {
    const stats = await loadStats();
    console.log(`  数据源：data/*.json 假数据（本地 D1 还没有数据）`);
    console.log(`  数据量：${stats.admissionRows} 条录取记录 / ${stats.universities} 所院校 / ${stats.majors} 个专业`);
  }
  console.log(`  接口：/api/meta  /api/query  /api/recommend`);
});
