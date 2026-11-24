// 按名字找会话：先查 bili 账本的 sessions 表（title / host_title 都是现成的），
// 账本里没有的再退回读会话文件开头几帧的首条用户消息。返回 id + 标题 + 体积 + 空闲秒数。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

import { BILI_DB, SESSIONS_ROOT } from './paths.js';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const HEAD_BYTES = 1 << 20;

/** 磁盘上所有会话：uuid → { dir, file, size, mtime }。 */
function indexDisk() {
  const out = new Map();
  if (!fs.existsSync(SESSIONS_ROOT)) return out;
  const workspaces = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
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
      // 目录名可能是 session-<uuid>，也可能就是 <uuid>
      const id = e.name.startsWith('session-') ? e.name.slice('session-'.length) : e.name;
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      const dir = path.join(base, e.name);
      const file = path.join(dir, 'session.v4.jsonl.zstd');
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      out.set(id, { dir, file, size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

/** 账本里的标题：uuid → { title, host, updatedAt }。没有账本就返回空。 */
function indexDb() {
  const out = new Map();
  if (!fs.existsSync(BILI_DB)) return out;
  let db;
  try {
    db = new DatabaseSync(BILI_DB);
    const rows = db.prepare('select session_id, title, host_title, updated_at from sessions').all();
    for (const r of rows) {
      const id = String(r.session_id || '').replace(/^session-/, '');
      if (!id) continue;
      out.set(id, { title: r.title || '', host: r.host_title || '', updatedAt: Number(r.updated_at) || 0 });
    }
  } catch {
    // 账本被占用或表结构变了：不致命，只是没有标题可用
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** 只读文件开头一段，够解前几帧。 */
function headSlice(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((x) => (typeof x === 'string' ? x : x?.text || '')).join(' ');
  }
  return '';
}

/** 会话文件里第一条用户消息的开头（账本没标题时的兜底）。 */
function firstUserText(file) {
  let buf;
  try {
    buf = headSlice(file);
  } catch {
    return '';
  }
  const offs = [];
  let i = 0;
  for (;;) {
    const j = buf.indexOf(MAGIC, i);
    if (j < 0) break;
    offs.push(j);
    i = j + 4;
  }
  if (!offs.length) return '';
  const parts = [];
  for (let k = 0; k < Math.min(offs.length, 3); k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8'));
    } catch {
      break;
    }
  }
  for (const line of parts.join('').split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'user/message') {
      const t = textOf(ev.data?.content).replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
  }
  return '';
}

/**
 * 按名字找会话。query 为空时列出最近的若干条。
 * @param {string} [query] 会话名关键词（子串，不区分大小写），也可以是 id 前缀
 * @param {number} [limit=10]
 */
export function findSessions(query = '', limit = 10) {
  const q = String(query || '').trim().toLowerCase();
  const disk = indexDisk();
  const db = indexDb();
  const rows = [];

  for (const [id, d] of disk) {
    const meta = db.get(id);
    let title = meta?.title || '';
    let host = meta?.host || '';
    if (!title && !host && q) {
      title = firstUserText(d.file);
    }
    rows.push({
      id,
      host,
      title,
      sizeBytes: d.size,
      idleSec: Math.max(0, Math.round((Date.now() - d.mtime) / 1000)),
      inDb: Boolean(meta),
    });
  }

  let picked = rows;
  if (q) {
    picked = rows.filter((r) => {
      const hay = `${r.id} ${r.host} ${r.title}`.toLowerCase();
      return hay.includes(q) || r.id.startsWith(q);
    });
  }

  // host 命中优先（那是鱼的名字），其次标题，最后才是 id；同组按最近活跃排。
  const score = (r) => {
    if (!q) return 0;
    if (r.host.toLowerCase().includes(q)) return 0;
    if (r.title.toLowerCase().includes(q)) return 1;
    return 2;
  };
  picked.sort((a, b) => score(a) - score(b) || a.idleSec - b.idleSec);
  const total = picked.length;
  const lim = Math.max(1, Math.min(50, Number(limit) || 10));
  return {
    query: q,
    total,
    sessions: picked.slice(0, lim).map((r) => ({
      ...r,
      title: r.title.slice(0, 100),
      host: r.host.slice(0, 40),
    })),
  };
}
