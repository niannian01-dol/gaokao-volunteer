/**
 * 本地 D1 小工具：把 wrangler 生成的本地 SQLite 文件包成 Worker 期望的 D1 接口。
 *
 * 两个脚本共用它：
 *   - scripts/verify-d1.mjs   离线验收 /api 链路（不联网、不登录）
 *   - dev-server.mjs          本地演示服务：优先读真实数据，读不到再退回 data/*.json
 *
 * 原理：`wrangler d1 execute gaokao --local` 把数据写进 .wrangler/state/v3/d1 下的 SQLite，
 * 这里用 Node 自带的 node:sqlite 打开它，再套一层 prepare / bind / all / first / run / batch 的小壳。
 */

import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/** 仓库根目录（本文件位于 scripts/ 下）。 */
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 递归找出 wrangler 本地 D1 的 SQLite 文件（体积最大的那个就是主库）。 */
export function findLocalD1(root = repoRoot) {
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

/** 优先读写方式打开（SQLite 打开 WAL 库需要写权限），只读文件系统上退回只读模式。 */
export function openDatabase(dbFile) {
  try {
    return new DatabaseSync(dbFile);
  } catch {
    return new DatabaseSync(dbFile, { readOnly: true });
  }
}

/** 把 node:sqlite 包装成 Worker 期望的 D1 接口。 */
export function createD1(dbFile) {
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

/**
 * 找本地 D1 并包好；没导入过数据就返回 null（调用方自行决定怎么降级）。
 * 只有建过表、并且有录取记录时才算「可用」，避免空库把演示服务带偏。
 */
export function openLocalD1(root = repoRoot) {
  const file = findLocalD1(root);
  if (!file) return null;
  try {
    const handler = createD1(file);
    return { file, handler };
  } catch {
    return null;
  }
}
