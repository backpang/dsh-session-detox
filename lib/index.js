// 注册三个工具 + 自带 skill：detox_scan（只读诊断）/ detox_cut（剪会话文件）/ detox_blocks（剪压缩块摘要）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findSessionDir } from './paths.js';
import { scanSessionFile, cutSessionFile, IDLE_SECONDS } from './session.js';
import { scanBlocks, cutBlocks } from './blocks.js';
import { scanWorkspace, countHits } from './workspace.js';
import { findSessions } from './find.js';
import { guardStream } from './stream.js';
import { loadConfig, applyRuntime, RUNTIME } from './config.js';

export const name = 'dsh-session-detox';

/** 工具注册表是唯一硬依赖。 */
export const inject = ['tools'];

const pluginRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const SESSION_PARAM = {
  type: 'string',
  description: '会话 id 或它的前缀（uuid 前 8 位即可，例如 "5422f542"）。必填——不看磁盘分不清是哪条。',
};

function findTool() {
  return {
    name: 'detox_find',
    description:
      '按名字找会话：给关键词（会话名、标题片段、host 名）或 id 前缀，返回匹配的会话 id + 标题 + 体积 + 空闲秒数。'
      + '不给关键词就列出最活跃的若干条。先用它拿到 8 位 id，再喂给 detox_scan / detox_cut / detox_blocks。'
      + '标题优先取 billion-context 账本里的 title / host_title，账本里没有的再读会话文件开头几帧。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '会话名关键词（子串，不区分大小写），也可以直接给 id 前缀。省略＝列最近的。' },
        limit: { type: 'number', description: '最多返回几条，默认 10，上限 50。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          total: { type: 'number' },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                host: { type: 'string' },
                title: { type: 'string' },
                sizeBytes: { type: 'number' },
                idleSec: { type: 'number' },
                inDb: { type: 'boolean' },
              },
            },
          },
        },
        required: ['total', 'sessions'],
        additionalProperties: true,
      },
      render: (_a, v) => {
        if (!v.total) {
          return [{ type: 'text', text: `没有匹配 "${v.query}" 的会话。换个关键词，或者不带关键词先看一遍。` }];
        }
        const rows = v.sessions.map((s) => {
          const who = s.host ? `${s.host}` : '(无 host)';
          const mb = (s.sizeBytes / 1048576).toFixed(1);
          const state = s.idleSec < IDLE_SECONDS ? `还在写(${s.idleSec}s)` : `空闲 ${s.idleSec}s`;
          return `${s.id.slice(0, 8)}  ${who}  ${mb}MB  ${state}\n    ${s.title || '(无标题)'}`;
        });
        return [{
          type: 'text',
          text: lines([
            `匹配 "${v.query}" 的会话 ${v.total} 条${v.total > v.sessions.length ? `（只显示前 ${v.sessions.length} 条）` : ''}：`,
            '',
            ...rows,
            '',
            '下一步：把上面的 8 位 id 传给 detox_scan。idle 小于 180 秒的会话还在写，detox_cut 会拒绝。',
          ]),
        }];
      },
    },
    async execute(args) {
      const r = findSessions(args?.query, args?.limit);
      return { query: r.query, total: r.total, sessions: r.sessions };
    },
  };
}

function workspaceTool() {
  return {
    name: 'detox_workspace',
    description:
      '扫描工作区里「会被注入上下文」的文件——AGENTS.md（进每轮系统提示）、.dsh/skills 下的 skill（描述进目录、正文按需加载）'
      + '——列出里面残留的可疑内容：点名这类的措辞、相关小节标题、连写循环段。'
      + '只报告，不改任何文件：文档里的内容是给人看的，删不删要人判断。'
      + '只扫 DSH 通用结构，别的工作区自建的目录（如记忆库）不默认扫，要扫就显式传 root。',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: '工作区根目录；省略用进程当前目录。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          root: { type: 'string' },
          scanned: { type: 'number' },
          total: { type: 'number' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                kind: { type: 'string' },
                hits: { type: 'array', items: { type: 'object' } },
              },
            },
          },
        },
        required: ['root', 'scanned', 'total', 'files'],
        additionalProperties: true,
      },
      render: (_a, v) => {
        const head = v.total
          ? `扫了 ${v.scanned} 个会被注入的文件，${v.files.length} 个文件里共 ${v.total} 处可疑`
          : `扫了 ${v.scanned} 个会被注入的文件，没有发现可疑内容`;
        const body = [];
        for (const f of v.files) {
          body.push(`\n${f.path}  (${f.kind})`);
          for (const h of f.hits.slice(0, 12)) {
            body.push(`  L${h.line}  [${h.label}]  ${h.snippet}`);
          }
          if (f.hits.length > 12) body.push(`  …还有 ${f.hits.length - 12} 处`);
        }
        return [{ type: 'text', text: lines([head, ...body, v.total ? '\n这些要人来看：改不改、怎么改由你定，工具只指位置。' : '']) }];
      },
    },
    async execute(args) {
      const root = args?.root || process.cwd();
      const r = scanWorkspace(root);
      return { root, scanned: r.scanned, total: countHits(r), files: r.files };
    },
  };
}

function resolve(session) {
  const hit = findSessionDir(session);
  if (!hit) throw new Error(`找不到会话 "${session}"。去 ~/.dsh/sessions/ 下看目录名。`);
  return hit;
}

function lines(arr) {
  return arr.filter(Boolean).join('\n');
}

function scanTool() {
  return {
    name: 'detox_scan',
    description:
      '只读扫描一条 DSH 会话：数出思考里有多少条要改、多少处极短行、多少段连写循环，'
      + '以及压缩块摘要里几块还带着重复行。不改任何文件，随时可以跑。'
      + '要动手之前先跑它确认数字。',
    parameters: {
      type: 'object',
      properties: { session: SESSION_PARAM },
      required: ['session'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          session: { type: 'string' },
          file: { type: 'string' },
          mtimeAgeSec: { type: 'number' },
          writable: { type: 'boolean' },
          events: { type: 'number' },
          touched: { type: 'number' },
          stubs: { type: 'number' },
          loops: { type: 'number' },
          chars: { type: 'number' },
          blocksTotal: { type: 'number' },
          blocksHit: { type: 'array', items: { type: 'string' } },
        },
        required: ['session', 'file', 'mtimeAgeSec', 'writable', 'events', 'touched', 'blocksTotal', 'blocksHit'],
        additionalProperties: true,
      },
      render: (_a, v) => [{
        type: 'text',
        text: lines([
          `会话 ${v.session}`,
          `文件 ${v.file}（mtime ${v.mtimeAgeSec} 秒前${v.writable ? '，可动' : '，还在写'}）`,
          `会话语料：事件 ${v.events}，待改 ${v.touched} 条，极短行 ${v.stubs}，循环段 ${v.loops}，删字符 ${v.chars}`,
          v.blocksTotal
            ? `压缩块：共 ${v.blocksTotal} 块，${v.blocksHit.length ? `有残留：${v.blocksHit.join(', ')}` : '无残留'}`
            : '压缩块：没找到 billion-context 的账本——要么没装它，要么用的是别的压缩插件（看下面那行）',
          '判据说明：极短行按「字数」认（默认 1~3 个汉字、可选句号、独占一行，不认具体是哪个字）——'
          + '这个长度在思考里没有正经用途，删了不算误伤。循环段按「连写」认。'
          + '要放宽到 4~5 个字就改 lib/detect.js 的 STUB_LINE 成 {1,4}，但那时会开始碰到正常短句，一格一格试；'
          + '两条按词的判据（可疑小节标题、点名这个形态的那句话）是同源历史留下的说法，别处不叫这个名字就抓不到，补词即可。',
          '压缩块识别：只认两种——billion-context 的 index.db（detox_blocks）与会话文件内的 compaction/summary 事件（detox_cut）。'
          + '官方 dsh-compaction-basic 与多数第三方后端（vcc / instant / pro / better-compact 等）最终都写 compaction/summary，已覆盖；'
          + '换成把块存在自己数据库里的压缩插件（如 compaction-tower）时，这一项会假阴性——显示无残留但实际可能有。'
          + '遇到不认识的压缩块，去 lib/blocks.js 照着加一个读取器，别信这里的 0。',
        ]),
      }],
    },
    async execute(args) {
      const hit = resolve(args?.session);
      const s = scanSessionFile(hit.file);
      let blocks = { total: 0, hits: [] };
      try {
        blocks = scanBlocks(hit.id.slice(0, 8));
      } catch {
        // 没装 billion-context 时压缩块这一项直接用空
      }
      return {
        session: hit.id,
        file: hit.file,
        mtimeAgeSec: s.mtimeAgeSec,
        writable: s.mtimeAgeSec >= IDLE_SECONDS,
        events: s.events,
        touched: s.touched,
        stubs: s.stubs,
        loops: s.loops,
        chars: s.chars,
        blocksTotal: blocks.total,
        blocksHit: blocks.hits,
      };
    },
  };
}

function cutTool() {
  return {
    name: 'detox_cut',
    description:
      '剪一条 DSH 会话的思考历史：把反复出现的极短碎句从 reasoning 块里删掉，'
      + '自动备份、打包回读校验、校验通过才覆盖，并删掉投影缓存。'
      + '会话还在写（mtime 不足 180 秒）时会拒绝——运行中写盘会把 seq 写断。只碰 reasoning 与 system/tool 文本，user 一个字不动。',
    parameters: {
      type: 'object',
      properties: {
        session: SESSION_PARAM,
        force: { type: 'boolean', description: '跳过 180 秒空闲检查（危险，通常不要用）。' },
      },
      required: ['session'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          session: { type: 'string' },
          backup: { type: 'string' },
          removedCache: { type: 'boolean' },
          events: { type: 'number' },
          touched: { type: 'number' },
          stubs: { type: 'number' },
          loops: { type: 'number' },
          chars: { type: 'number' },
          bytesAfter: { type: 'number' },
        },
        required: ['session', 'backup', 'events', 'touched'],
        additionalProperties: true,
      },
      render: (_a, v) => [{
        type: 'text',
        text: lines([
          `会话 ${v.session} 已处理`,
          `备份 ${v.backup}`,
          `事件 ${v.events}，改 ${v.touched} 条，极短行 ${v.stubs}，循环段 ${v.loops}，删字符 ${v.chars}`,
          `现在体积 ${v.bytesAfter} B${v.removedCache ? '，已删投影缓存' : ''}`,
          '会话文件已落盘、投影缓存已删——下次打开这条会话读到就是清洗后的内容，不用重启 DSH。',
          '（只有清压缩块的 detox_blocks 才必须重启：bili 进程内存里存着整份 payload，不重启会把磁盘改回去。）',
          `复查：再跑一次 detox_scan ${String(v.session || '').slice(0, 8)}，待改必须是 0。`,
        ]),
      }],
    },
    async execute(args) {
      const hit = resolve(args?.session);
      const r = cutSessionFile(hit.file, hit.id, { force: args?.force === true });
      return {
        session: r.session,
        backup: r.backup,
        removedCache: r.removedCache,
        events: r.events,
        touched: r.touched,
        stubs: r.stubs,
        loops: r.loops,
        chars: r.chars,
        bytesAfter: r.sizeAfter,
      };
    },
  };
}

function blocksTool() {
  return {
    name: 'detox_blocks',
    description:
      '清压缩块摘要里残留的重复行（billion-context 的 index.db）。这些摘要每轮随上下文注入，'
      + '留着等于每轮反复提醒模型用这种写法。改前整库备份（约 800MB），只改 summary，不动全文。'
      + '改完必须重启 DSH，否则进程内存里的整份 payload 会把磁盘改回去。',
    parameters: {
      type: 'object',
      properties: { session: SESSION_PARAM },
      required: ['session'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          backup: { type: 'string' },
          changed: { type: 'number' },
          details: { type: 'array', items: { type: 'object' } },
        },
        required: ['backup', 'changed'],
        additionalProperties: true,
      },
      render: (_a, v) => [{
        type: 'text',
        text: lines([
          `账本备份 ${v.backup}`,
          `改了 ${v.changed} 块`,
          ...v.details.map((d) => `  ${d.id}: ${d.before} -> ${d.after} 字符`),
          v.changed ? '改了压缩块：必须重启 DSH 才会真正生效（不重启，进程内存里的整份 payload 几十秒内会把磁盘改回去）。重启后再跑 detox_scan 确认没有回退。' : '没有需要改的块。不用重启。',
        ]),
      }],
    },
    async execute(args) {
      const hit = resolve(args?.session);
      const r = cutBlocks(hit.id.slice(0, 8));
      return { backup: r.backup, changed: r.changed, details: r.details };
    },
  };
}

/**
 * @param {import('cordis').Context} ctx
 */
export function apply(ctx) {
  applyRuntime(loadConfig());

  for (const tool of [findTool(), scanTool(), cutTool(), blocksTool(), workspaceTool()]) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-session-detox: ${tool.name}`);
  }

  // skill 是说明书，不是硬依赖：没有 skills 服务的 profile 照样能用工具。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (skillCtx) => {
      try {
        const skillDir = path.join(pluginRoot, 'skills', 'session-detox');
        const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
        skillCtx.effect(() => skillCtx.skills.register({
          name: 'session-detox',
          description: '用 dsh-session-detox 插件清理 DSH 会话：扫描 → 剪会话文件 → 清压缩块 → 重启复查。',
          whenToUse: '当用户说「给这条会话清理一下」「她思考里老重复极短句」「压缩块里还留着重复行」「帮我切一下她的历史」，'
            + '或者你要判断一条会话里残留多少时。',
          content,
          resourceBase: { kind: 'directory', path: skillDir },
          source: 'bundled',
        }), 'dsh-session-detox: skill');
      } catch {
        // 没 skill 服务就算了，工具还能用
      }
    });
  }

  // ---- 流中截断：挂在 llm/stream waterfall 上 ----
  //
  // ⚠️ 必须**同步返回** AsyncIterable：cordis 的 waterfall 是纯同步的（next() 直接 return
  // 最外层监听器的返回值），监听器一旦写成 async，宿主拿到的是 Promise 而不是流，
  // for await 立刻抛「stream is not async iterable」，整个回合零输出。
  // 所以默认 streamGuard = false；确认要开再改 ~/.dsh/session-detox.json。
  if (typeof ctx.on === 'function') {
    try {
      const off = ctx.on('llm/stream', (options, next) => {
        const upstream = next();
        if (!upstream || typeof upstream[Symbol.asyncIterator] !== 'function') {
          return upstream; // 上游不是流，原样放行
        }
        if (RUNTIME.streamGuard !== true) return upstream; // 没开
        try {
          return guardStream(upstream, {
            onHit: (info) => {
              // 只记一行，不写文件：这一步不该影响生成
              try {
                console.error('[session-detox] 流中截断', JSON.stringify(info));
              } catch {
                /* 记日志失败忽略 */
              }
            },
          });
        } catch {
          return upstream; // 包不起来就原样放行
        }
      });
      if (typeof off === 'function') {
        ctx.effect(() => off, 'dsh-session-detox: llm/stream');
      }
    } catch (e) {
      console.error('[session-detox] 挂 llm/stream 失败（只保留工具）：', e?.message ?? e);
    }
  }
}

export default { name, inject, apply };
