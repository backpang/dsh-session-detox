// 工作区扫描：找出「会被注入上下文」的文件里残留的可疑内容。
// 只报告、不改文件——文档里的极短行可能是正常内容，删不删得人来看。
import fs from 'node:fs';
import path from 'node:path';

import { LOOP, BAD_SECT, BAD_LINE } from './detect.js';

/** 这些目录里的东西不进上下文，扫了只是噪声。 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'temp',
  '_gen',
  'comfy-out',
  'comfy-models',
  'ollama-models',
  'ollama-dist',
  '存档',
  '截图',
  'B站视频',
  '备份',
  'skills-disabled',
]);

/** 只有这些位置的内容会被注入或被读进上下文。
 *  记忆库这类目录是某些工作区自建的，不是 DSH 通用结构，所以不放进默认扫描——
 *  要扫就显式传 root 指过去。 */
const TARGETS = [
  { rel: 'AGENTS.md', kind: '系统提示' },
  { rel: '.dsh/skills', kind: 'skill（描述进目录、正文按需加载）', mode: 'dir' },
];

// LOOP 在 detect.js 里带 /g，用 .test() 会因 lastIndex 残留而交替返回真假（实测 true/false/true）。
// 这里用一份去掉 g 的副本，逐行判定才不会漏报。
const LOOP_TEST = new RegExp(LOOP.source);

const RULES = [
  { id: 'germ-word', re: /单字祈使句/, label: '点名这类的措辞' },
  { id: 'bad-sect', re: /^#{2,3}[^\n]*(?:主人点出本鱼|本鱼.{0,4}的病)/, label: '相关小节标题' },
  { id: 'loop', re: LOOP_TEST, label: '连写循环段' },
];
// 注意：文档里**不报**「独立极短行」这一条。存档与记忆里大量正常内容就是一两行短句
// （主人原话、操作小结），按会话文件的判据扫过去全是误报——2026-11-22 实测 7 处命中全是误报。

function walkMd(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.name.endsWith('的存档')) continue; // 历史存档不常被 read，扫了只是噪声
      walkMd(full, out);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
}

/**
 * 扫工作区里会被注入上下文的文件。
 * @param {string} root 工作区根
 * @returns {{ scanned: number, files: Array<{ path: string, kind: string, hits: Array<{ line: number, rule: string, label: string, snippet: string }> }> }}
 */
export function scanWorkspace(root) {
  const files = [];
  for (const t of TARGETS) {
    const full = path.join(root, t.rel);
    if (!fs.existsSync(full)) continue;
    if (t.mode === 'dir') {
      const list = [];
      walkMd(full, list);
      for (const f of list) files.push({ path: f, kind: t.kind });
    } else {
      files.push({ path: full, kind: t.kind });
    }
  }

  const report = [];
  let scanned = 0;
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f.path, 'utf8');
    } catch {
      continue;
    }
    scanned++;
    const lines = text.split('\n');
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const rule of RULES) {
        if (!rule.re.test(line)) continue;
        const trimmed = line.trim();
        // 行内循环段单独报，不跟极短行规则重复计数
        if (rule.id === 'loop' && !(trimmed.match(LOOP) || []).length) continue;
        hits.push({
          line: i + 1,
          rule: rule.id,
          label: rule.label,
          snippet: trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed,
        });
        break;
      }
    }
    if (hits.length) report.push({ path: f.path, kind: f.kind, hits });
  }
  return { scanned, files: report };
}

/** 扫出来的总数（给一句话结论用）。 */
export function countHits(report) {
  return report.files.reduce((n, f) => n + f.hits.length, 0);
}

/** BAD_SECT / BAD_LINE 这两个正则只在这里用，导出去让调用方能复用。 */
export { BAD_SECT, BAD_LINE };
