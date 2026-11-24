// 路径解析：DSH 家目录、会话目录、bili 账本、备份目录。全部按 DSH_HOME / homedir 推，不写死盘符。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** DSH 家目录：优先环境变量，否则 ~/.dsh。 */
export const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

/** 会话根目录：~/.dsh/sessions/<workspace>/session-<uuid>/session.v4.jsonl.zstd */
export const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions');

/** 投影缓存目录：删掉对应 session-<uuid>.json 让宿主重算。 */
export const PROJCACHE_DIR = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');

/** billion-context 账本（压缩块摘要在这里）。 */
export const BILI_DB = path.join(os.homedir(), '.local', 'share', 'billion-context', 'sessions', 'index.db');

/** 手术备份目录。 */
export const BACKUP_ROOT = path.join(DSH_HOME, 'detox-backups');

/**
 * 在 sessions 根下按 id 前缀找会话目录。
 * @param {string} prefix 会话 id 前缀（uuid 前 8 位即可）
 * @returns {{ dir: string, id: string, file: string } | null}
 */
export function findSessionDir(prefix) {
  if (!fs.existsSync(SESSIONS_ROOT)) return null;
  const workspaces = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
  const hits = [];
  for (const ws of workspaces) {
    const base = path.join(SESSIONS_ROOT, ws.name);
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // 目录名两种都有：session-<uuid> 和裸 <uuid>，只认前者会漏掉一大半
      const raw = e.name.startsWith('session-') ? e.name.slice('session-'.length) : e.name;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(raw)) continue;
      if (!raw.startsWith(prefix)) continue;
      const dir = path.join(base, e.name);
      const file = path.join(dir, 'session.v4.jsonl.zstd');
      if (fs.existsSync(file)) hits.push({ dir, id: raw, file });
    }
  }
  // 前缀也可能带 "session-" 前缀传进来
  if (!hits.length && prefix.startsWith('session-')) return findSessionDir(prefix.slice('session-'.length));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const exact = hits.find((h) => h.id === prefix);
    if (exact) return exact;
    throw new Error(`前缀 "${prefix}" 匹配到 ${hits.length} 个会话，请给长一点：${hits.map((h) => h.id.slice(0, 12)).join(', ')}`);
  }
  return null;
}

/** 某会话的投影缓存文件路径（可能不存在）。 */
export function projcacheFile(id) {
  return path.join(PROJCACHE_DIR, `session-${id}.json`);
}

/** 备份文件名里的时间戳：YYYYMMDD-HHMMSS。 */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 确保目录存在。 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
