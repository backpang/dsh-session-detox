# 更新记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.3.0] - 2026-11-22

### 新增
- **流中截断**（`lib/stream.js`）：挂在 `llm/stream` 上，边收 `reasoning-delta` 边判，命中就停止转发这一段，并把落盘的 `block-end` 换成截断版（保留开头 240 字 + 一句收尾，里面的极短行顺手清掉）。默认关，配置项 `streamGuard`。
- `lib/config.js`：`~/.dsh/session-detox.json` 读写；每次流都重新读，改完不用重启。
- 测试 +5 项（`loopScore` 不误杀 / 命中，`truncate` 形态，`guardStream` 正常流透传 / 退化流停转发且 `block-end` 被换）。

### 说明
- 挂 `llm/stream` 的监听器**必须同步返回** `AsyncIterable`：cordis 的 waterfall 是纯同步的，写成 `async` 会让宿主拿到 `Promise`，`for await` 抛 `stream is not async iterable`，整个回合零输出。所以 `streamGuard` 默认 `false`，且所有异常路径都退回原样透传。

## [0.2.0] - 2026-11-22

### 修复
- **`detox_workspace` 漏报连写循环段**：`LOOP` 是带 `/g` 的正则，直接 `.test()` 会因 `lastIndex` 残留而交替返回真假（实测 true/false/true），扫描时每隔一行漏一次。改用去掉 `g` 的副本（`lib/workspace.js`）。
- `detox_blocks` 返回的 `total` 恒为 0，改为实际改动块数（`lib/blocks.js`）。
- `cutSessionFile` 返回字段 `sizeIn` 名字与含义相反（实际是覆盖**后**的大小），改名 `sizeAfter`（`lib/session.js`）。
- `SKIP_DIRS` 里 `'.dsh\\skills-disabled'` 永远匹配不上（`readdirSync` 给的是单层目录名），删除该死条目（`lib/workspace.js`）。

### 变更
- **`engines.node` 从 `>=22` 收紧到 `>=24`**：`node:sqlite` 在 22.x 需要 `--experimental-sqlite` flag，23.x 也不稳定，24 起免 flag。
- 全文去掉与特定历史绑定的说法，统一用「极短碎句 / 重复行 / 残留」。判据正则本身不动（要匹配才抓得到）。

### 文档
- README 重写：补安装步骤、四个工具（之前写「三个」）、Node 版本要求、压缩插件兼容表、两个可能意外的行为（重打包换帧大小、剪会话文件不用重启）。
- 修正 README「`session` 省略则用当前会话」——实际是必填参数。
- 新增 `LICENSE`（MIT）、`.gitignore`、本文件。

## [0.1.0] - 2026-11-21

### 新增
- 四个工具：`detox_scan` / `detox_cut` / `detox_blocks` / `detox_workspace`。
- 多帧 zstd 解包与重打包（`lib/zstd.js`），首帧只放 header、其余每 400 条事件一帧。
- 回读校验：内容逐字节一致、首帧恰好一行、`seq` 无空洞、`user/message` 都带 `role`。
- 支持 `compaction/summary` 事件（原版 DSH 与多数第三方压缩后端）。
- 自带 skill `session-detox`。
