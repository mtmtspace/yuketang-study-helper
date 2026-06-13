// 交互式向导（TUI）：拿到脚本的人 `npm start` 即可按提示填 Key、登录、粘贴作业网址、选模式作答。
// 零额外依赖：Node 内置 readline + ANSI 颜色。底层复用 answer-loop / course-loop。

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { parseArgs, saveEnv } from "./config.mjs";
import { launchBrowser, closeBrowser, findYuketangPage } from "./browser.mjs";
import { createLogger } from "./logger.mjs";
import { extractInPage } from "./extract.mjs";
import { sleep, dismissPopups, answerHomework } from "./answer-loop.mjs";
import { runCourse } from "./course-loop.mjs";

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", blue: "\x1b[34m",
};
const paint = (s, col) => `${col}${s}${C.reset}`;
const rl = readline.createInterface({ input, output });
const ask = (q) => rl.question(q);

function banner() {
  console.log("");
  console.log(paint("  ┌────────────────────────────────────┐", C.cyan));
  console.log(paint("  │   雨课堂自动答题 · 交互式向导        │", C.cyan + C.bold));
  console.log(paint("  └────────────────────────────────────┘", C.cyan));
  console.log(paint("  截图 + 视觉大模型识别作答，支持单份/整门课，可选自动提交。", C.dim));
}

// 常见 OpenAI 兼容服务商预设（模型须支持视觉/读图；型号仅为示例，可改）。
const PRESETS = [
  { name: "火山方舟 doubao（默认）", base: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seed-2-0-lite-260215" },
  { name: "OpenAI", base: "https://api.openai.com/v1", model: "gpt-4o" },
  { name: "阿里通义千问 DashScope", base: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-vl-max" },
  { name: "智谱 GLM", base: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4v-plus" },
  { name: "月之暗面 Kimi", base: "https://api.moonshot.cn/v1", model: "moonshot-v1-32k-vision-preview" },
  { name: "硅基流动 SiliconFlow", base: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-VL-72B-Instruct" },
  { name: "OpenRouter", base: "https://openrouter.ai/api/v1", model: "openai/gpt-4o" },
];

// 发一条小请求测试 key/base/model 是否可用。
async function testApi(args) {
  process.stdout.write(paint("  测试连通性……", C.dim));
  try {
    const r = await fetch(`${args.apiBase.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: args.model, messages: [{ role: "user", content: "ping" }], max_tokens: 5 }),
    });
    if (r.ok) {
      console.log(paint(" 通 ✓", C.green));
      return true;
    }
    const t = await r.text();
    let msg = t;
    try { msg = JSON.parse(t)?.error?.message || t; } catch { /* */ }
    console.log(paint(` 失败 HTTP ${r.status}：${String(msg).slice(0, 90)}`, C.red));
    return false;
  } catch (e) {
    console.log(paint(" 失败：" + e.message, C.red));
    return false;
  }
}

// 配置服务商 / 模型 / Key（首次或菜单重配）。
async function setupProvider(args, force = false) {
  if (args.apiKey && !force) {
    console.log(paint(`  ✓ API 已配置（${args.apiBase}，模型 ${args.model}）`, C.green));
    return true;
  }
  console.log("");
  console.log(paint("  选择 API 服务商（模型必须支持【视觉/读图】）：", C.bold));
  PRESETS.forEach((p, i) => console.log(`    ${i + 1}) ${p.name}  ${paint(p.base, C.dim)}`));
  console.log(`    ${PRESETS.length + 1}) 自定义（任意 OpenAI 兼容接口）`);
  console.log(paint("  注：Anthropic 原生(/v1/messages)接口不支持。", C.dim));
  const sel = (await ask("  选择 [默认 1]: ")).trim() || "1";
  const idx = parseInt(sel, 10) - 1;

  let base, model;
  if (idx >= 0 && idx < PRESETS.length) {
    base = PRESETS[idx].base;
    model = PRESETS[idx].model;
  } else {
    base = (await ask("  API Base（如 https://xxx/v1）: ")).trim();
    model = "";
    if (!base) { console.log(paint("  未填 Base，取消。", C.red)); return false; }
  }
  const mIn = (await ask(`  模型 ID${model ? `（回车用 ${model}）` : "（必填）"}: `)).trim();
  if (mIn) model = mIn;
  if (!model) { console.log(paint("  未填模型，取消。", C.red)); return false; }

  const k = (await ask(paint("  粘贴 API Key: ", C.bold))).trim();
  if (!k) { console.log(paint("  未提供 Key，取消。", C.red)); return false; }

  args.apiKey = k;
  args.apiBase = base;
  args.model = model;
  process.env[args.apiKeyEnv] = k;
  process.env.ARK_API_BASE = base;
  process.env.ARK_MODEL = model;
  const p = saveEnv({ [args.apiKeyEnv]: k, ARK_API_BASE: base, ARK_MODEL: model });
  console.log(paint(`  ✓ 已保存到 ${p}（下次免填）`, C.green));
  await testApi(args);
  return true;
}

async function chooseMode(args) {
  console.log("");
  console.log(paint("  作答方式：", C.bold));
  console.log("    1) 试运行   —— 只看模型答案，不点选（先验证准确率）");
  console.log("    2) 只勾选   —— 勾上答案但不提交，做完你人工核对提交");
  console.log("    3) 勾选并提交 —— 每题选完自动提交、翻页（" + paint("提交不可逆！", C.red) + "）");
  const m = (await ask("  选择 [1/2/3]: ")).trim();
  if (m === "1") { args.dryRun = true; args.submit = false; }
  else if (m === "2") { args.dryRun = false; args.submit = false; }
  else if (m === "3") {
    const yes = (await ask(paint("  自动提交不可逆，确认开始？(y/N): ", C.yellow))).trim().toLowerCase();
    if (yes !== "y" && yes !== "yes") { console.log(paint("  已取消。", C.yellow)); return false; }
    args.dryRun = false; args.submit = true;
  } else { console.log(paint("  无效选择，已取消。", C.yellow)); return false; }
  return true;
}

async function waitForQuestions(page) {
  console.log(paint("  等待题目加载（若未登录，请在浏览器窗口里登录）……", C.dim));
  for (let i = 0; i < 40; i += 1) {
    const q = await page.evaluate(extractInPage).catch(() => null);
    if (q && q.ok && q.options.length) return true;
    await dismissPopups(page).catch(() => {});
    await sleep(1500);
  }
  return false;
}

async function finishSummary(logger, args) {
  const sum = logger.summary();
  const logPath = await logger.save();
  console.log("");
  console.log(paint(`  完成：处理 ${sum.total} 题 | 已勾选 ${sum.clicked} | 已提交 ${sum.submitted} | 失败 ${sum.failed}`, C.green + C.bold));
  if (!args.submit && !args.dryRun) console.log(paint("  （未提交，请在浏览器核对后手动点提交/交卷）", C.yellow));
  console.log(paint(`  日志: ${logPath}`, C.dim));
}

async function doSingle(args, context, shotDir) {
  const url = (await ask(paint("  粘贴【作业页】URL（地址栏里含 /exercise/ 那串）: ", C.bold))).trim();
  if (!url) { console.log(paint("  未输入，返回。", C.yellow)); return; }
  if (!(await chooseMode(args))) return;

  const logger = createLogger(args.outDirAbs);
  const page = findYuketangPage(context, args.urlContains) || context.pages()[0] || (await context.newPage());
  console.log(paint("  打开作业页……", C.dim));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => console.log(paint("  打开失败: " + e.message, C.red)));
  await sleep(1500);
  await dismissPopups(page).catch(() => {});
  if (!(await waitForQuestions(page))) {
    console.log(paint("  没检测到题目（可能未登录或这不是作业题目页）。返回菜单。", C.yellow));
    return;
  }
  await answerHomework(args, context, page, logger, shotDir);
  await finishSummary(logger, args);
}

async function doCourse(args, context, shotDir) {
  const url = (await ask(paint("  粘贴【学习日志/成绩单页】URL（含 /studentLog/）: ", C.bold))).trim();
  if (!url) { console.log(paint("  未输入，返回。", C.yellow)); return; }
  if (!(await chooseMode(args))) return;

  const logger = createLogger(args.outDirAbs);
  const page = context.pages()[0] || (await context.newPage());
  console.log(paint("  进入成绩单、遍历作业……", C.dim));
  const { doneCount, planned } = await runCourse(args, context, page, logger, shotDir, url);
  console.log(paint(`  本次处理作业 ${doneCount}/${planned} 份`, C.green));
  await finishSummary(logger, args);
}

async function openLogin(context) {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto("https://changjiang.yuketang.cn/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  console.log("");
  console.log(paint("  请在弹出的浏览器窗口里打开你的雨课堂并【登录】（已登录可跳过）。", C.bold));
  console.log(paint("  若你的雨课堂不是 changjiang，自行在窗口地址栏打开你学校的雨课堂登录。", C.dim));
  await ask(paint("  登录完成后按【回车】继续……", C.dim));
  console.log(paint("  好的，登录态已保存在本地配置档，下次免登。", C.green));
}

async function main() {
  banner();
  const args = parseArgs([]); // TUI 驱动，忽略命令行参数
  await mkdir(args.outDirAbs, { recursive: true });
  const shotDir = resolve(args.outDirAbs, "shots");
  await mkdir(shotDir, { recursive: true });

  if (!(await setupProvider(args))) { rl.close(); return; }

  console.log(paint("\n  正在启动 Chrome（用你已装的 Chrome，独立配置档，不影响日常浏览器）……", C.dim));
  let context;
  try {
    ({ context } = await launchBrowser(args));
  } catch (e) {
    console.log(paint("  启动浏览器失败: " + e.message, C.red));
    console.log(paint("  请确认：已安装 Google Chrome；已在项目目录执行过 npm install。", C.yellow));
    rl.close();
    return;
  }

  await openLogin(context);

  for (;;) {
    console.log("");
    console.log(paint("  ── 主菜单 ──", C.bold + C.cyan));
    console.log("    1) 做单份作业");
    console.log("    2) 批量做整门课（自动遍历成绩单里未完成的作业）");
    console.log("    3) 切换模型  当前: " + paint(args.model, C.cyan));
    console.log("    4) 重新登录 / 检查登录");
    console.log("    5) 重新配置 API（换服务商 / 模型 / Key）");
    console.log("    0) 退出");
    const ch = (await ask("  选择: ")).trim();
    try {
      if (ch === "1") await doSingle(args, context, shotDir);
      else if (ch === "2") await doCourse(args, context, shotDir);
      else if (ch === "3") {
        const m = (await ask("  输入模型 ID（回车保持不变）: ")).trim();
        if (m) { args.model = m; console.log(paint("  已切换到 " + m, C.green)); }
      } else if (ch === "4") await openLogin(context);
      else if (ch === "5") await setupProvider(args, true);
      else if (ch === "0") break;
      else console.log(paint("  无效选择。", C.yellow));
    } catch (e) {
      console.log(paint("  出错: " + (e.message || e), C.red));
    }
  }

  console.log(paint("  正在关闭……", C.dim));
  await closeBrowser(context);
  rl.close();
  console.log(paint("  再见！", C.green));
}

main().catch((e) => {
  console.error(paint("运行失败: " + (e.message || e), C.red));
  try { rl.close(); } catch { /* */ }
  process.exitCode = 1;
});
