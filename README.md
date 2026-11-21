# dsh-session-detox

清理 DSH 会话历史里反复出现的极短碎句：把思考（`reasoning`）里一行一个动词的那种行删掉，再把同样形态残留在压缩摘要里的段落清掉。

为什么摘要也要清：压缩摘要**每轮都随上下文注入**，留着等于反复提醒模型「你就是这么写的」。

零依赖，纯 node（`node:zlib` 的 zstd + `node:sqlite`），不需要 python、不需要外部脚本、不联网。

## 要求

- **Node >= 24**（`node:sqlite` 在 22.x 需要 `--experimental-sqlite`，24 起免 flag；本包实测于 24.21.0）
- DSH >= 0.2.0

## 安装

把仓库目录放进 profile 的 `node_modules`，再在 profile 的 `package.json` 里登记两处：

```bash
cp -r dsh-session-detox ~/.dsh/profiles/<profile>/node_modules/
```

```json
{
  "dependencies": {
    "dsh-session-detox": "file:./node_modules/dsh-session-detox"
  },
  "dsh": {
    "bundles": ["dsh-session-detox"]
  }
}
```

重启 DSH，四个工具就出现在工具列表里。

## 四个工具

| 工具 | 作用 | 危险度 |
|---|---|---|
| `detox_scan` | 只读扫描一条会话：待改条数、极短行数、循环段数，以及压缩块里哪几块带残留 | 零 |
| `detox_workspace` | 扫工作区里**会被注入上下文**的文件（`AGENTS.md` / `.dsh/skills`），列出残留。只报告不改 | 零 |
| `detox_cut` | 剪会话文件：自动备份 → 清洗 → 回读校验 → 覆盖 → 删投影缓存 | 中 |
| `detox_blocks` | 剪压缩块摘要（billion-context 的 `index.db`），改前整库备份 | 中 |

## 用法

```
detox_scan      { "session": "5422f542" }
detox_workspace { }
detox_cut       { "session": "5422f542" }
detox_blocks    { "session": "5422f542" }
```

`session` **必填**，传会话 id 或其前缀（uuid 前 8 位能唯一匹配即可）。

## 三条硬规矩

1. **会话在写时不动刀**。`detox_cut` 自己查 mtime，不足 180 秒直接拒绝——运行中的会话写断 seq 会打不开。`force: true` 只在确认已停但仍报忙时用。
2. **剪压缩块必须重启 DSH**。不重启，进程内存里的整份 payload 会把磁盘改回去（实测清完 12 分钟后又变回原样）。
3. **`user/message` 一个字都不动**，`tool-call` 的 `arguments` 也不动——格式校验器逐字节比对这两处。

## 判据

都在 `lib/detect.js` 顶部：

| 常量 | 认什么 | 换别的会话还灵吗 |
|---|---|---|
| `STUB_LINE` | 整行只有 1~3 个汉字（可带句号） | **灵**，按字数认，不认具体是哪个字 |
| `LOOP` | 这种短句连写 3 次以上 | **灵**，按连写认 |
| `BAD_SECT` | 摘要里整段可疑小节 | 不灵，正则里写死了同源历史的标题写法 |
| `BAD_LINE` | 摘要里点名这个形态的整行 | 不灵，同上 |

**要调的是字数阈值**：有的模型写四个字的短句，把 `{1,3}` 改成 `{1,4}`。放宽会多误伤正常短句，一格一格试。

**别放宽成「含某个词就删整句」**——旧版这么干过，把正常的一句用户要求整条删了。

## 压缩摘要存在哪

| 压缩插件 | 摘要位置 | 谁清 |
|---|---|---|
| billion-context | 自己的 `index.db`（`blocks` 表） | `detox_blocks` |
| 官方 `dsh-compaction-basic` 与多数第三方（vcc / instant / pro / better-compact） | 会话文件里的 `compaction/summary` 事件 | `detox_cut` |
| 自建存储的（如 `compaction-tower`） | 自己的库或文件 | 要自己加读取器 |

**`detox_scan` 报「没找到账本」或「共 0 块」不等于干净**——很可能是压缩插件换了存储方式。这时去看那个插件的源码，照着 `lib/blocks.js` 写一份对应的读取器。

## 两个可能让人意外的行为

- **重打包会换帧大小**。清洗时整个文件重新分帧（每 400 条事件一帧），所以字节数变化是正常的，内容逐字节校验过（`identical`）。
- **剪会话文件不用重启**。文件已落盘 + 投影缓存已删，下次打开读到的就是清洗后的内容。只有 `detox_blocks` 需要重启。

## 备份

- 会话文件：`~/.dsh/detox-backups/orig-<id前8位>-<时间戳>.v4.jsonl.zstd`
- 压缩块账本：`~/.dsh/detox-backups/index.db.bak-<时间戳>`（整库，约 800MB，注意磁盘）

校验没过时**不覆盖原文件**，清洗结果另存 `failed-<id前8位>-<时间戳>.jsonl` 供排查。

## 文件

- `lib/index.js` — 注册四个工具 + skill
- `lib/session.js` — 找会话、扫、剪
- `lib/blocks.js` — 压缩块扫描与清理
- `lib/workspace.js` — 工作区扫描
- `lib/detect.js` — 判据与清洗
- `lib/zstd.js` — 多帧 zstd 解包 / 打包 / 回读校验
- `lib/paths.js` — 路径解析（跨平台，不写死盘符）
- `skills/session-detox/SKILL.md` — 插件自带的用法说明

## License

MIT
