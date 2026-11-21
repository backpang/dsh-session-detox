// 判据与清洗：什么样的行算「极短碎句」、压缩块摘要里哪一段算可疑段落，以及怎么切。
// 改判据只改这个文件顶部的四个正则。
//
// 【这些判据不一定都适合别的鱼——先看清楚哪条按形态、哪条按词】
//
//   STUB_LINE  按形态判：只要求「1~3 个汉字 + 可选句号 + 独占一行」，**不认具体是哪个字**。
//              所以别人写的是别的字照样抓得到。真要调的是**字数阈值**：有的鱼写四个字的
//              短句，把 {1,3} 改成 {1,4} 就行。
//   LOOP       按形态判：任意汉字加句号连写三次以上，同样不认字。
//   BAD_SECT   按词判：某个固定的标题写法（同源会话留下的，正则里写死了那几个词）。
//   BAD_LINE   按词判：某句固定的说法（同上）。
//
// 也就是说：**主判据（极短行、循环段）对别的会话一样有效**；两条按词的只适用于
// 同源历史，别处抓不到是正常的，往这两个正则里补词即可。别把「抓不到」当成「没东西」。

/** 整行只有 1~3 个汉字（可带句号）算极短碎句。别放宽成「含某个词就删整句」。 */
export const STUB_LINE = /^[\u4e00-\u9fa5]{1,3}。?$/;

/** 这种极短句连写 3 次以上算循环段（句号必须，不能写成 `。?`——那样任何连续汉字都会命中）。 */
export const LOOP = /(?:[\u4e00-\u9fa5]。[ \t]*){3,}/g;

/** 摘要里整段可疑小节要整段剪掉（标题是某个同源会话留下的固定写法，见下面的正则）。 */
export const BAD_SECT = /^#{2,3}[^\n]*(?:主人点出本鱼|本鱼.{0,4}的病)[^\n]*\n[\s\S]*?(?=^#{2,3} |(?![\s\S]))/gm;

/** 摘要里点名这个形态的整行要删。 */
export const BAD_LINE = /^.*单字祈使句.*$(\r?\n)?/gm;

/**
 * 清一段文本：删独立极短行 + 删连写循环段。
 * @param {string} t
 * @returns {{ text: string, stubs: number, chars: number, loops: number }}
 */
export function cleanText(t) {
  if (!t) return { text: t, stubs: 0, chars: 0, loops: 0 };
  const before = t.length;
  const keep = [];
  let stubs = 0;
  for (const ln of t.split('\n')) {
    if (STUB_LINE.test(ln.trim())) {
      stubs++;
      continue;
    }
    keep.push(ln);
  }
  let out = keep.join('\n');
  const loops = (out.match(LOOP) || []).length;
  out = out.replace(LOOP, '');
  return { text: out, stubs, chars: before - out.length, loops };
}

/**
 * 清压缩块摘要：整段剪掉可疑小节 + 删点名这个形态的整行。
 * @param {string} s
 * @returns {string}
 */
export function cleanSummary(s) {
  if (!s) return s;
  let out = s.replace(BAD_SECT, '\n');
  out = out.replace(BAD_LINE, '');
  return out;
}

/** 摘要里有没有可疑内容（比较清洗前后，避开全局正则 lastIndex 的坑）。 */
export function summaryHasGerm(s) {
  if (!s) return false;
  return cleanSummary(s) !== s;
}

/** 递归遍历任意节点里所有 `text` 字符串字段（system/message、tool/result 用）。
 * @returns {{ touched: number, stubs: number, chars: number, loops: number }}
 */
function walkTexts(node, mutate) {
  const acc = { touched: 0, stubs: 0, chars: 0, loops: 0 };
  const visit = (n) => {
    if (Array.isArray(n)) {
      for (const x of n) visit(x);
      return;
    }
    if (!n || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n)) {
      if (k === 'text' && typeof v === 'string') {
        const r = cleanText(v);
        if (r.chars > 0) {
          if (mutate) n[k] = r.text;
          acc.touched++;
          acc.stubs += r.stubs;
          acc.chars += r.chars;
          acc.loops += r.loops;
        }
        continue;
      }
      if (v && typeof v === 'object') visit(v);
    }
  };
  visit(node);
  return acc;
}

/** 这些键是结构（区间、序号、id、归属），不是给人看的文本，清理时必须绕开，
 *  否则 v3→v4 的格式校验会报 shadowedRange / shadowedSeqs 对不上。 */
const STRUCT_KEYS = new Set([
  'shadowedRange', 'shadowedSeqs', 'sourceEventSeq', 'sourceEventSeqs',
  'surfaceOp', 'type', 'id', 'turn', 'step', 'compactionId',
]);

/**
 * 递归清任意节点里的字符串值。给 `compaction/summary` 这种没有统一 text 字段的事件用。
 *
 * 为什么要它：**原版 DSH 的压缩摘要是会话文件里的 `compaction/summary` 事件**
 * （`data.summary` / `data.rawOutput`），跟 bili 完全不是一回事——bili 把块存在自己的
 * index.db 里、会话文件里一个字都不留。所以：
 *   - 装了 billion-context → 压缩块在 index.db，用 `detox_blocks` 清
 *   - 没装、用原版压缩 → 摘要就在这个事件里，由 `detox_cut` 顺手清掉
 */
function cleanStrings(node, mutate, acc) {
  const handle = (v) => {
    if (typeof v === 'string') {
      const r = cleanText(v);
      if (r.chars > 0) {
        acc.touched++;
        acc.stubs += r.stubs;
        acc.chars += r.chars;
        acc.loops += r.loops;
        return r.text;
      }
      return v;
    }
    cleanStrings(v, mutate, acc);
    return v;
  };
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const before = node[i];
      const out = handle(before);
      if (mutate && typeof before === 'string' && out !== before) node[i] = out;
    }
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (STRUCT_KEYS.has(k)) continue;
    const out = handle(v);
    if (mutate && typeof v === 'string' && out !== v) node[k] = out;
  }
}

/**
 * 处理一条事件。
 * - assistant/message：只碰 content[].type === 'reasoning' 的 text（tool-call 的 arguments 一个字不动）
 * - system/message、tool/result：递归碰所有 text
 * - user/message：一律跳过，那是主人自己的话
 * @param {any} ev
 * @param {boolean} mutate 是否写回
 * @returns {{ touched: number, stubs: number, chars: number, loops: number }}
 */
export function walkEvent(ev, mutate) {
  const type = ev?.type;
  const data = ev?.data || {};
  if (type === 'user/message') return { touched: 0, stubs: 0, chars: 0, loops: 0 };
  if (type === 'assistant/message') {
    const acc = { touched: 0, stubs: 0, chars: 0, loops: 0 };
    const content = data?.message?.content;
    if (!Array.isArray(content)) return acc;
    for (const c of content) {
      if (!c || c.type !== 'reasoning' || typeof c.text !== 'string') continue;
      const r = cleanText(c.text);
      if (r.chars > 0) {
        if (mutate) c.text = r.text;
        acc.touched++;
        acc.stubs += r.stubs;
        acc.chars += r.chars;
        acc.loops += r.loops;
      }
    }
    return acc;
  }
  if (type === 'system/message' || type === 'tool/result') {
    return walkTexts(data.message, mutate);
  }
  if (type === 'compaction/summary') {
    // 原版 DSH 的压缩摘要：摘要正文在 data 里，按字符串递归清
    const acc = { touched: 0, stubs: 0, chars: 0, loops: 0 };
    cleanStrings(data, mutate, acc);
    return acc;
  }
  return { touched: 0, stubs: 0, chars: 0, loops: 0 };
}

/** 这条事件需不需要改（scan 用，不写回）。 */
export function eventNeedsChange(ev) {
  return walkEvent(ev, false).chars > 0;
}
