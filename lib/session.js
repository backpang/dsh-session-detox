// 会话文件的扫描与手术：解包 → 逐条判 → 备份 → 清洗 → 轻校验 → 覆盖 → 删投影缓存。
import fs from 'node:fs';
import path from 'node:path';

import { unpack, pack, verifyPack } from './zstd.js';
import { walkEvent, eventNeedsChange } from './detect.js';
import { BACKUP_ROOT, ensureDir, projcacheFile, stamp } from './paths.js';

/** 会话文件 mtime 距今不足这么久，就认为它还在写，拒绝动刀。 */
export const IDLE_SECONDS = 180;

/**
 * 读会话文件并统计。
 * @param {string} file
 * @returns {{ events: number, touched: number, stubs: number, loops: number, chars: number, frames: number, mtimeAgeSec: number }}
 */
export function scanSessionFile(file) {
  const age = (Date.now() - fs.statSync(file).mtimeMs) / 1000;
  const { text, frames } = unpack(fs.readFileSync(file));
  const stat = { events: 0, touched: 0, stubs: 0, loops: 0, chars: 0 };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    stat.events++;
    const r = walkEvent(ev, false);
    stat.touched += r.touched;
    stat.stubs += r.stubs;
    stat.loops += r.loops;
    stat.chars += r.chars;
  }
  return { ...stat, frames, mtimeAgeSec: Math.round(age) };
}

/** 只在需要改的行上重新序列化，其余行逐字节保留（seq / arguments / user 全文都不动）。 */
function cleanJsonl(text) {
  const out = [];
  const stat = { events: 0, touched: 0, stubs: 0, loops: 0, chars: 0 };
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      out.push(line); // 解析不了的原样留着，不因为一行坏掉把整份搞乱
      continue;
    }
    stat.events++;
    if (!eventNeedsChange(ev)) {
      out.push(line);
      continue;
    }
    const r = walkEvent(ev, true);
    stat.touched += r.touched;
    stat.stubs += r.stubs;
    stat.loops += r.loops;
    stat.chars += r.chars;
    out.push(JSON.stringify(ev));
  }
  return { text: out.join('\n'), stat };
}

/**
 * 给一个会话文件动手术。
 * @param {string} file
 * @param {string} id
 * @param {{ force?: boolean }} [opts]
 * @returns {object} 结果摘要
 */
export function cutSessionFile(file, id, opts = {}) {
  const age = (Date.now() - fs.statSync(file).mtimeMs) / 1000;
  if (!opts.force && age < IDLE_SECONDS) {
    throw new Error(
      `会话 id=${id} 还在写（mtime ${Math.round(age)} 秒前，判据 ${IDLE_SECONDS} 秒）。停掉它再来，否则会把 seq 写断。\n`
      + '如果切的就是你自己这条会话：你自己说话/调工具都会写事件，mtime 永远归零，你会永远切不了自己——'
      + '改派一个子智能体，让它在等待期间什么都不写，等过 180 秒再切（见 skill 的《给自己清理》一节）。',
    );
  }

  ensureDir(BACKUP_ROOT);
  const stampStr = stamp();
  const backup = path.join(BACKUP_ROOT, `orig-${id.slice(0, 8)}-${stampStr}.v4.jsonl.zstd`);
  fs.copyFileSync(file, backup);

  const { text } = unpack(fs.readFileSync(file));
  const { text: cleaned, stat } = cleanJsonl(text);
  const packed = pack(cleaned);
  const check = verifyPack(packed, cleaned);
  if (!check.ok) {
    const dump = path.join(BACKUP_ROOT, `failed-${id.slice(0, 8)}-${stampStr}.jsonl`);
    fs.writeFileSync(dump, cleaned, 'utf8');
    throw new Error(`校验没过，没有覆盖原文件：${check.problems.join('；')}。清洗结果留在 ${dump}`);
  }

  fs.writeFileSync(file, packed);
  const cache = projcacheFile(id);
  let removedCache = false;
  if (fs.existsSync(cache)) {
    fs.rmSync(cache, { force: true });
    removedCache = true;
  }

  return {
    session: id,
    backup,
    removedCache,
    ...stat,
    events: check.events,
    framesIn: check.frames,
    seqMin: check.seqMin,
    seqMax: check.seqMax,
    sizeAfter: fs.statSync(file).size,
  };
}
