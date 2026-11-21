// 多帧 zstd：按 magic 切帧逐帧解 / 首帧只放 header，其余每 N 条事件一帧。
// DSH 会话文件是多帧 zstd，zstdDecompressSync 只解第一帧，所以必须自己切帧。
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 每帧装多少条事件（打包时）。 */
export const EVENTS_PER_FRAME = 400;

/** 在一段 buffer 里找出所有 zstd 帧的起始偏移。 */
export function frameOffsets(buf) {
  const offs = [];
  let i = 0;
  for (;;) {
    const j = buf.indexOf(MAGIC, i);
    if (j < 0) break;
    offs.push(j);
    i = j + 4;
  }
  return offs;
}

/**
 * 解包多帧 zstd → 文本（jsonl）。
 * @param {Buffer} buf 文件字节
 * @returns {{ text: string, frames: number }}
 */
export function unpack(buf) {
  const offs = frameOffsets(buf);
  if (!offs.length) throw new Error('没找到 zstd 帧；这不是多帧会话文件？');
  const parts = [];
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    parts.push(zlib.zstdDecompressSync(buf.subarray(offs[k], end)));
  }
  const whole = Buffer.concat(parts);
  return { text: whole.toString('utf8'), frames: offs.length };
}

/**
 * 打包：首帧恰好 header 一行，之后每 EVENTS_PER_FRAME 条事件一帧。
 * @param {string} text jsonl 全文
 * @returns {Buffer}
 */
export function pack(text) {
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length < 2) throw new Error('jsonl 里没有事件（只有 header？）');
  const frames = [];
  // 首帧必须恰好一行 header，多一行宿主会报 first frame is not exactly one header line
  frames.push(zlib.zstdCompressSync(Buffer.from(lines[0] + '\n', 'utf8')));
  for (let i = 1; i < lines.length; i += EVENTS_PER_FRAME) {
    const chunk = lines.slice(i, i + EVENTS_PER_FRAME).map((l) => l + '\n').join('');
    frames.push(zlib.zstdCompressSync(Buffer.from(chunk, 'utf8')));
  }
  return Buffer.concat(frames);
}

/**
 * 轻校验：解回暖结果与源 jsonl 逐字节一致、首帧正好一行、seq 无空洞、user/message 都有 role。
 * @param {Buffer} packed 打包结果
 * @param {string} srcText 源 jsonl
 * @returns {{ ok: boolean, frames: number, identical: boolean, gaps: number, missingRole: number, events: number, seqMin: number|null, seqMax: number|null, problems: string[] }}
 */
export function verifyPack(packed, srcText) {
  const problems = [];
  const offs = frameOffsets(packed);
  const firstEnd = offs.length > 1 ? offs[1] : packed.length;
  const firstText = zlib.zstdDecompressSync(packed.subarray(0, firstEnd)).toString('utf8');
  const firstLines = firstText.split('\n').filter((l) => l.length > 0);
  if (firstLines.length !== 1) problems.push(`首帧有 ${firstLines.length} 行，应恰好 1 行`);

  const parts = [];
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : packed.length;
    parts.push(zlib.zstdDecompressSync(packed.subarray(offs[k], end)));
  }
  const whole = Buffer.concat(parts);
  const src = Buffer.from(srcText, 'utf8');
  const identical = whole.equals(src);
  if (!identical) problems.push(`回读与源 jsonl 不一致（${whole.length} vs ${src.length} 字节）`);

  const seqs = [];
  let missingRole = 0;
  let events = 0;
  for (const line of whole.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    events++;
    let o;
    try {
      o = JSON.parse(line);
    } catch (e) {
      problems.push(`第 ${events} 行不是合法 JSON：${e.message}`);
      continue;
    }
    if (typeof o.seq === 'number') seqs.push(o.seq);
    if (o.type === 'user/message') {
      const d = o.data || {};
      if (d.role !== 'user') missingRole++;
    }
  }
  if (missingRole > 0) problems.push(`${missingRole} 条 user/message 缺 role`);

  seqs.sort((a, b) => a - b);
  let gaps = 0;
  for (let i = 0; i + 1 < seqs.length; i++) {
    if (seqs[i + 1] !== seqs[i] + 1) gaps++;
  }
  if (gaps > 0) problems.push(`seq 有 ${gaps} 处空洞`);

  return {
    ok: problems.length === 0,
    frames: offs.length,
    identical,
    gaps,
    missingRole,
    events,
    seqMin: seqs.length ? seqs[0] : null,
    seqMax: seqs.length ? seqs[seqs.length - 1] : null,
    problems,
  };
}
