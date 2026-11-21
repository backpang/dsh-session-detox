// 配置：~/.dsh/session-detox.json。默认流中截断**关着**——包 stream 有整轮零输出的风险面，见 README。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** DSH 家目录（与 paths.js 一致，但这里允许用 DSH_HOME 覆盖）。 */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

export const CONFIG_FILE = path.join(DSH_HOME, 'session-detox.json');

export const DEFAULTS = Object.freeze({
  /** 流中截断：命中就在当轮停转发、并把落盘的 block-end 换成截断版。默认关。 */
  streamGuard: false,
});

/** 运行中的生效配置：guardStream 每次调用都读它，所以改完配置文件不用重启。 */
export const RUNTIME = { ...DEFAULTS };

export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return { streamGuard: src.streamGuard === true };
}

export function loadConfig() {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch {
    return { ...DEFAULTS };
  }
}

/** 把配置灌进 RUNTIME。 */
export function applyRuntime(cfg) {
  const next = normalizeConfig(cfg);
  Object.assign(RUNTIME, next);
  return { ...RUNTIME };
}

/** 写回配置文件并立即生效。 */
export function saveConfig(patch = {}) {
  const next = normalizeConfig({ ...loadConfig(), ...patch });
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  applyRuntime(next);
  return next;
}
