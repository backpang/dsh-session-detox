// 流中截断：挂在 llm/stream 上，边收 reasoning-delta 边判，命中就停止转发这一段思考。
// 关键不是界面不刷屏 —— 而是把 block-end 也换成截断版：**只有落盘的那份决定下一轮会不会被回灌**。
import { STUB_LINE, cleanText } from './detect.js';

/** 尾部窗口：只看最后这么多字。循环通常紧邻结尾。 */
const TAIL_CHARS = 2000;
/** 攒够这么多字才开始判，省得每来一个 delta 都跑一遍。 */
const MIN_PROBE = 80;
/** 之后每多攒这么多字判一次。 */
const PROBE_STEP = 40;
/** 连续这么多行是极短碎句就熔断。 */
const RUN_LIMIT = 5;
/** 或者：尾部极短行占到一半、且至少这么多行。 */
const RATIO_MIN = 0.5;
const STUB_MIN = 10;
/** 尾部至少这么多行才判，太少不判（开头几句正常短句不该被误伤）。 */
const MIN_LINES = 10;
/** 保留的尾部行数上限。 */
const TAIL_LINES = 40;
/** 截断时保留开头这么多字。 */
const KEEP_HEAD = 240;
/** 思考文本的内存上限；超了只留尾巴，判定只看尾部，砍中段不影响。 */
const MAX_KEEP_CHARS = 200000;
/** 截断后接的一句。 */
const YIELD_TEXT = '\n…（这里绕进去了，换个说法继续）';

/**
 * 判一段文本（通常只喂尾部）在不在绕。
 * @param {string} text
 * @returns {{ reasons: string[], ratio: number, maxRun: number, stubs: number, lines: number } | null}
 */
export function loopScore(text) {
  const lines = String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < MIN_LINES) return null;

  const tail = lines.slice(-TAIL_LINES);
  let stubs = 0;
  let run = 0;
  let maxRun = 0;
  for (const line of tail) {
    if (STUB_LINE.test(line)) {
      stubs++;
      run++;
      if (run > maxRun) maxRun = run;
    } else {
      run = 0;
    }
  }

  const ratio = stubs / tail.length;
  const reasons = [];
  if (maxRun >= RUN_LIMIT) reasons.push(`run:${maxRun}`);
  if (ratio >= RATIO_MIN && stubs >= STUB_MIN) reasons.push(`ratio:${ratio.toFixed(2)}`);
  if (!reasons.length) return null;
  return { reasons, ratio, maxRun, stubs, lines: tail.length };
}

/**
 * 截断：保留开头（顺手把里面的碎句行删掉）+ 一句收尾。
 * 保留原文是给下一轮留上下文，删碎句是别把退化形态再写回历史。
 * @param {string} text
 * @param {number} [keepHead]
 */
export function truncate(text, keepHead = KEEP_HEAD) {
  const src = String(text ?? '');
  const head = src.length > keepHead ? src.slice(0, keepHead) : src;
  return cleanText(head).text.trimEnd() + YIELD_TEXT;
}

/**
 * 包一层 stream：拦住 reasoning 里的极短碎句。
 * 任何异常都退回原样透传 —— 绝不能让这个插件把模型调用搞挂。
 *
 * chunk 类型（DSH 的 llm/stream）：
 *   block-start | text-delta | reasoning-delta | tool-call-delta | block-end | usage | finish
 *
 * @param {AsyncIterable<any>} upstream
 * @param {{ onHit?: (info: object) => void }} [opts]
 */
export async function* guardStream(upstream, opts = {}) {
  const slots = new Map(); // index -> { text, halted, lastProbe }
  const onHit = typeof opts.onHit === 'function' ? opts.onHit : null;

  try {
    for await (const chunk of upstream) {
      if (!chunk || typeof chunk !== 'object') {
        yield chunk;
        continue;
      }

      if (chunk.type === 'reasoning-delta') {
        const idx = chunk.index ?? 0;
        let slot = slots.get(idx);
        if (!slot) {
          slot = { text: '', halted: false, lastProbe: 0 };
          slots.set(idx, slot);
        }
        if (slot.halted) continue; // 这一段已经熔断，后面全部丢掉

        slot.text += String(chunk.text ?? '');
        if (slot.text.length > MAX_KEEP_CHARS) slot.text = slot.text.slice(-TAIL_CHARS * 4);

        if (slot.text.length >= MIN_PROBE && slot.text.length - slot.lastProbe >= PROBE_STEP) {
          slot.lastProbe = slot.text.length;
          try {
            const probe = slot.text.length > TAIL_CHARS ? slot.text.slice(-TAIL_CHARS) : slot.text;
            const hit = loopScore(probe);
            if (hit) {
              slot.halted = true;
              if (onHit) {
                try {
                  onHit({ index: idx, chars: slot.text.length, ...hit });
                } catch {
                  /* 记日志失败不影响熔断 */
                }
              }
              continue; // 这个 delta 也不转发
            }
          } catch {
            // 判据出错就放行：宁可漏抓，不能把整轮搞挂
          }
        }

        yield chunk;
        continue;
      }

      if (chunk.type === 'block-end') {
        const idx = chunk.index ?? 0;
        const slot = slots.get(idx);
        if (slot?.halted) {
          // 关键：落盘的那份也要换掉，否则碎句进历史、下一轮自我强化
          const kept = truncate(slot.text);
          slots.delete(idx);
          yield { ...chunk, block: { type: 'reasoning', text: kept } };
          continue;
        }
        slots.delete(idx);
        yield chunk;
        continue;
      }

      yield chunk;
    }
  } finally {
    slots.clear();
  }
}
