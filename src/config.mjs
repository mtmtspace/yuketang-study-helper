// 配置：CLI 参数 + 环境变量解析，集中默认值。
// 不把 API Key 写进源码；从环境变量（默认 ARK_API_KEY）或同目录 .env 读取。

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(__dirname, "..");

export const DEFAULTS = {
  apiBase: "https://ark.cn-beijing.volces.com/api/v3",
  model: "doubao-seed-2-0-mini-260215",
  apiKeyEnv: "ARK_API_KEY",
  urlContains: "yuketang.cn",
  profileDir: ".chrome-profile",
  outDir: "output",
  // 每次模型调用 / 点击之间的最小间隔（毫秒），避免过快操作。
  delayMs: 600,
  // 单题点击后等待 UI 稳定的时间。
  clickSettleMs: 350,
  maxQuestions: 200,
  // 刷课：完成度轮询间隔（毫秒）
  watchPollMs: 3000,
};

// 极简 .env 加载器：KEY=VALUE，每行一条，# 注释。不覆盖已存在的环境变量。
function loadDotEnv() {
  const envPath = resolve(PROJECT_ROOT, ".env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseAnswerList(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("--answers JSON 必须是数组");
    return parsed.map(normalizeManualAnswer);
  }
  return text
    .split(/[,，;；]/)
    .map(normalizeManualAnswer)
    .filter(Boolean);
}

function normalizeManualAnswer(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (/^(true|t|正确|对|是)$/i.test(text)) return "true";
  if (/^(false|f|错误|错|否)$/i.test(text)) return "false";
  return text;
}

export function parseArgs(argv = process.argv.slice(2)) {
  loadDotEnv();

  const args = {
    dryRun: false,
    noLlm: false,
    force: false,
    headless: false,
    exitWhenDone: false,
    model: process.env.ARK_MODEL || DEFAULTS.model,
    apiBase: process.env.ARK_API_BASE || DEFAULTS.apiBase,
    apiKeyEnv: DEFAULTS.apiKeyEnv,
    urlContains: DEFAULTS.urlContains,
    openUrl: "",
    cdp: "",
    submit: false,
    todo: false,
    agentDump: false,
    answersFile: "",
    only: "",
    profileDir: DEFAULTS.profileDir,
    outDir: DEFAULTS.outDir,
    delayMs: DEFAULTS.delayMs,
    clickSettleMs: DEFAULTS.clickSettleMs,
    maxQuestions: DEFAULTS.maxQuestions,
    maxHomeworks: 0,
    answers: [],
    // —— 刷课(watch)相关 ——
    speed: 2, // 视频倍速
    mute: true, // 静音
    onlyChapter: "", // 只刷标题含该关键字的章节
    discuss: false, // 讨论环节自动复制最新评论发送
    maxUnits: 0, // 最多刷 N 个学习单元（0=不限）
    watchPollMs: DEFAULTS.watchPollMs,
    startNewQuiz: false, // quiz 模块：允许启动未开始试卷
    startQuestion: null,
    targetIndex: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    switch (arg) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--no-llm":
        args.noLlm = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--headless":
        args.headless = true;
        break;
      case "--exit-when-done":
        args.exitWhenDone = true;
        break;
      case "--model":
        args.model = next();
        break;
      case "--api-base":
        args.apiBase = next();
        break;
      case "--api-key-env":
        args.apiKeyEnv = next();
        break;
      case "--url-contains":
        args.urlContains = next();
        break;
      case "--open-url":
      case "--url":
        args.openUrl = next();
        break;
      case "--cdp":
        args.cdp = next();
        break;
      case "--submit":
        args.submit = true;
        break;
      case "--todo":
        args.todo = true;
        break;
      case "--agent-dump":
        args.agentDump = true;
        break;
      case "--answers-file":
        args.answersFile = next();
        break;
      case "--only":
        args.only = next();
        break;
      case "--profile-dir":
        args.profileDir = next();
        break;
      case "--out":
        args.outDir = next();
        break;
      case "--delay":
        args.delayMs = Number.parseInt(next(), 10);
        break;
      case "--max-questions":
        args.maxQuestions = Number.parseInt(next(), 10);
        break;
      case "--max-homeworks":
        args.maxHomeworks = Number.parseInt(next(), 10);
        break;
      case "--answers":
        args.answers = parseAnswerList(next());
        break;
      case "--speed":
        args.speed = Number.parseFloat(next());
        break;
      case "--no-mute":
        args.mute = false;
        break;
      case "--only-chapter":
        args.onlyChapter = next();
        break;
      case "--discuss":
        args.discuss = true;
        break;
      case "--max-units":
        args.maxUnits = Number.parseInt(next(), 10);
        break;
      case "--watch-poll":
        args.watchPollMs = Number.parseInt(next(), 10);
        break;
      case "--start-new-quiz":
        args.startNewQuiz = true;
        break;
      case "--start-question":
        args.startQuestion = Number.parseInt(next(), 10);
        break;
      case "--target-index":
        args.targetIndex = Number.parseInt(next(), 10);
        break;
      default:
        throw new Error(`未知参数: ${arg}`);
    }
  }

  args.apiKey = process.env[args.apiKeyEnv] || "";
  args.profileDirAbs = resolve(PROJECT_ROOT, args.profileDir);
  args.outDirAbs = resolve(PROJECT_ROOT, args.outDir);
  return args;
}

export function requireApiKey(args) {
  if (!args.apiKey) {
    throw new Error(
      `缺少 API Key：请设置环境变量 ${args.apiKeyEnv}，或在项目根目录创建 .env（见 .env.example）。`,
    );
  }
}

// 把若干 KEY=VALUE 写入/更新 .env（供交互式向导首次保存 API Key 等）。
export function saveEnv(updates) {
  const envPath = resolve(PROJECT_ROOT, ".env");
  const lines = existsSync(envPath)
    ? readFileSync(envPath, "utf8").split(/\r?\n/)
    : [];
  for (const [k, v] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => l.trim().startsWith(`${k}=`));
    const line = `${k}=${v}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  writeFileSync(envPath, lines.join("\n").replace(/\n+$/, "") + "\n", "utf8");
  return envPath;
}
