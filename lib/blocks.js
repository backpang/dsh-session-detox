// 压缩块摘要：billion-context 的 index.db 里，每块摘要若残留重复行，每轮随上下文注入。
// 只改 payload_json.summary，content 表里的全文一个字不动。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { cleanSummary, summaryHasGerm } from './detect.js';
import { BACKUP_ROOT, BILI_DB, ensureDir, stamp } from './paths.js';

function openDb() {
  if (!fs.existsSync(BILI_DB)) {
    throw new Error(`bili 账本不存在：${BILI_DB}（没装 billion-context 时压缩块这一刀用不上）`);
  }
  return new DatabaseSync(BILI_DB);
}

/**
 * 扫压缩块。
 * @param {string} prefix 会话 id 前缀
 * @returns {{ total: number, hits: string[] }}
 */
export function scanBlocks(prefix) {
  const db = openDb();
  try {
    const rows = db.prepare('select block_id, payload_json from blocks where session_id like ?')
      .all(`%${prefix}%`);
    const hits = [];
    for (const row of rows) {
      let summary = '';
      try {
        summary = JSON.parse(row.payload_json)?.summary || '';
      } catch {
        continue;
      }
      if (summaryHasGerm(summary)) hits.push(row.block_id);
    }
    return { total: rows.length, hits };
  } finally {
    db.close();
  }
}

/**
 * 清压缩块摘要里的重复行。
 * @param {string} prefix
 * @returns {{ backup: string, total: number, changed: number, details: Array<{ id: string, before: number, after: number }> }}
 */
export function cutBlocks(prefix) {
  ensureDir(BACKUP_ROOT);
  const backup = path.join(BACKUP_ROOT, `index.db.bak-${stamp()}`);
  fs.copyFileSync(BILI_DB, backup);

  const db = openDb();
  const details = [];
  try {
    const rows = db.prepare('select block_id, payload_json from blocks where session_id like ?')
      .all(`%${prefix}%`);
    const update = db.prepare('update blocks set payload_json = ? where block_id = ? and session_id like ?');
    for (const row of rows) {
      let payload;
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        continue;
      }
      const old = payload?.summary || '';
      const next = cleanSummary(old);
      if (next === old) continue;
      payload.summary = next;
      update.run(JSON.stringify(payload), row.block_id, `%${prefix}%`);
      details.push({ id: row.block_id, before: old.length, after: next.length });
    }
  } finally {
    db.close();
  }
  return { backup, total: details.length, changed: details.length, details };
}
