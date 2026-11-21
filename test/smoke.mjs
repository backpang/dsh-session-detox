// 冒烟测试：判据、清洗、zstd 往返、工作区扫描、全局正则回归。用法 `node test/smoke.mjs`
// 不需要真实会话文件，全部自带夹具，跑完只在临时目录里留东西（结尾清掉）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cleanText, cleanSummary, walkEvent, STUB_LINE, LOOP } from '../lib/detect.js';
import { unpack, pack, verifyPack } from '../lib/zstd.js';
import { scanWorkspace, countHits } from '../lib/workspace.js';

// 用码点拼，避免源码里出现真实病态字面
const S = '\u505a';          // 一个字
const STUB = S + '\u3002';   // 一个字 + 句号
const LINE3 = STUB + STUB + STUB;

let pass = 0;
const ok = (name, fn) => {
  fn();
  console.log('  PASS', name);
  pass++;
};

console.log('judge（判据）');
ok('STUB_LINE 认独占一行的 1~3 字短句', () => {
  assert.equal(STUB_LINE.test(STUB), true);
  assert.equal(STUB_LINE.test('\u56de\u7b54\u3002'), true);
  assert.equal(STUB_LINE.test('\u8fd9\u662f\u4e00\u53e5\u6b63\u5e38\u7684\u8bdd\u3002'), false);
});
ok('LOOP 认连写 3 次，2 次不算', () => {
  assert.equal((LINE3.match(LOOP) || []).length, 1);
  assert.equal((STUB + STUB).match(LOOP), null);
});
ok('一整行只有一个词（含应答类）都算碎句，这不是误伤', () => {
  // 思考里 1~3 个字独占一行没有任何正经用途：既没有对什么做、也没有做到哪一步
  assert.equal(STUB_LINE.test('\u597d\u7684\u3002'), true); // 「好的。」
  assert.equal(STUB_LINE.test('\u6536\u5230\u3002'), true); // 「收到。」
  assert.equal(STUB_LINE.test('\u8fd9\u4e2a\u6539\u5b8c\u4e86\u3002'), false); // 六字，正常句
  assert.equal(STUB_LINE.test('OK'), false);
});

console.log('clean（清洗）');
ok('cleanText 删极短行、保留正常行', () => {
  const src = [S + '\u5199\u6587\u4ef6', STUB, '\u4fee\u6539\u914d\u7f6e\u4e2d\u7684\u8def\u5f84', STUB + S].join('\n');
  const r = cleanText(src);
  assert.equal(r.stubs, 1);
  assert.ok(r.text.includes('\u5199\u6587\u4ef6'));
  assert.ok(!r.text.includes(STUB + '\n'));
});
ok('cleanText 幂等：清两遍与清一遍结果相同', () => {
  const once = cleanText([STUB, '\u6b63\u5e38\u4e00\u53e5', STUB + S, LINE3].join('\n')).text;
  const twice = cleanText(once).text;
  assert.equal(once, twice);
});
ok('cleanSummary 删可疑小节整段', () => {
  const src = '## \u5f00\u5934\n\n\u4fdd\u7559\u8fd9\u6bb5\n\n## \u4e3b\u4eba\u70b9\u51fa\u672c\u9c7c\u7684\u95ee\u9898\n\n\u8981\u5220\u6389\n\n## \u7ed3\u5c3e\n\n\u4e5f\u4fdd\u7559\n';
  const out = cleanSummary(src);
  assert.ok(out.includes('\u4fdd\u7559\u8fd9\u6bb5'));
  assert.ok(out.includes('\u4e5f\u4fdd\u7559'));
  assert.ok(!out.includes('\u8981\u5220\u6389'));
});

console.log('walkEvent（只碰该碰的）');
ok('user/message 一个字不动', () => {
  const ev = { type: 'user/message', data: { content: STUB + '\n' + LINE3, role: 'user' } };
  const r = walkEvent(ev, true);
  assert.equal(r.chars, 0);
  assert.ok(ev.data.content.includes(STUB));
});
ok('assistant/message 只清 reasoning，tool-call 的 arguments 不动', () => {
  const args = JSON.stringify({ path: 'a/b' });
  const ev = {
    type: 'assistant/message',
    data: {
      message: {
        content: [
          { type: 'reasoning', text: STUB + '\n\u771f\u6b63\u601d\u8003\u7684\u4e00\u53e5\u8bdd' },
          { type: 'tool-call', name: 'read', arguments: args },
        ],
      },
    },
  };
  walkEvent(ev, true);
  assert.ok(!ev.data.message.content[0].text.includes(STUB + '\n'));
  assert.equal(ev.data.message.content[1].arguments, args);
});
ok('compaction/summary 会清，但结构键不动', () => {
  const ev = {
    type: 'compaction/summary',
    data: {
      summary: '## \u4e3b\u4eba\u70b9\u51fa\u672c\u9c7c\u7684\u95ee\u9898\n\n\u5220\u6389\n',
      rawOutput: STUB,
      compactionId: 'cmp_1',
      shadowedSeqs: [1, 2, 3],
      type: 'compaction',
    },
  };
  walkEvent(ev, true);
  assert.ok(!ev.data.summary.includes('\u5220\u6389'));
  assert.equal(ev.data.compactionId, 'cmp_1');
  assert.deepEqual(ev.data.shadowedSeqs, [1, 2, 3]);
  assert.equal(ev.data.type, 'compaction');
});

console.log('zstd（多帧往返）');
ok('pack → unpack 逐字节一致，首帧恰好一行', () => {
  const header = JSON.stringify({ format: 'dsh-session', version: 4 });
  const events = [];
  for (let i = 0; i < 5; i++) events.push(JSON.stringify({ seq: i, type: 'x', data: {} }));
  const text = [header, ...events].join('\n') + '\n';
  const packed = pack(text);
  const back = unpack(packed);
  assert.equal(back.text, text);
  assert.ok(back.frames >= 2);
});

console.log('workspace（扫描）');
ok('全局正则不因 lastIndex 漏报（回归 0.2.0 修的 bug）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'detox-ws-'));
  try {
    const skillDir = path.join(root, '.dsh', 'skills', 'demo');
    fs.mkdirSync(skillDir, { recursive: true });
    // 同一文件里多行连写循环：带 g 的旧实现会每隔一行漏一次
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      ['# demo', LINE3, 'normal line one', LINE3, 'normal line two', LINE3].join('\n'),
      'utf8',
    );
    const r = scanWorkspace(root);
    const hits = countHits(r);
    assert.equal(hits, 3, `期望 3 处，实际 ${hits}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n全部通过：${pass} 项`);
