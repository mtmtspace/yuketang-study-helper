// 交互式向导（TUI）：拿到脚本的人 `npm start` 即可按提示填 Key、登录、粘贴网址、选择作答或刷课。
// 零额外依赖：Node 内置 readline + ANSI 颜色。底层复用 answer-loop / course-loop / quiz-loop / watch-loop。

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
import { runQuizPapers } from "./quiz-loop.mjs";
import { runWatch } from "./watch-loop.mjs";

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
  console.log(paint("  │   雨课堂学习助手 · 交互式向导        │", C.cyan + C.bold));
  console.log(paint("  └────────────────────────────────────┘", C.cyan));
  console.log(paint("  支持作业辅助、整课遍历、新版试卷和学习内容刷课。", C.dim));
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

async function chooseQuizMode(args) {
  args.dryRun = false;
  args.noLlm = false;
  args.submit = false;
  console.log("");
  console.log(paint("  新版试卷处理方式：", C.bold));
  console.log("    1) 试运行       —— 只看模型答案，不填写");
  console.log("    2) 填写并保存   —— 填入/点选答案，但不最终交卷");
  console.log("    3) 填写并交卷   —— 每份试卷处理完后自动点最终交卷（" + paint("提交不可逆！", C.red) + "）");
  console.log("    4) 只核验结构   —— 不请求模型，只进页面截图/识别题框");
  const m = (await ask("  选择 [1/2/3/4]: ")).trim();
  if (m === "1") {
    args.dryRun = true;
  } else if (m === "2") {
    args.dryRun = false;
  } else if (m === "3") {
    const yes = (await ask(paint("  自动交卷不可逆，确认开始？(y/N): ", C.yellow))).trim().toLowerCase();
    if (yes !== "y" && yes !== "yes") {
      console.log(paint("  已取消。", C.yellow));
      return false;
    }
    args.submit = true;
  } else if (m === "4") {
    args.noLlm = true;
  } else {
    console.log(paint("  无效选择，已取消。", C.yellow));
    return false;
  }
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

// 答题类功能需要 API Key；刷课不需要。进入答题功能前按需配置。
async function ensureApi(args) {
  if (args.apiKey) return true;
  console.log(paint("  做题需要支持视觉的大模型 API；先配置一下（刷课则不需要）。", C.yellow));
  return await setupProvider(args, true);
}

async function doSingle(args, context, shotDir) {
  if (!(await ensureApi(args))) return;
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
  if (!(await ensureApi(args))) return;
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

async function doQuiz(args, context) {
  const url = (await ask(paint("  粘贴【学习日志/成绩单页】URL（含 /studentLog/）: ", C.bold))).trim();
  if (!url) { console.log(paint("  未输入，返回。", C.yellow)); return; }

  args.only = "";
  args.maxHomeworks = 0;
  args.todo = true;
  args.force = false;
  args.startNewQuiz = false;
  args.answers = [];

  const kw = (await ask("  只处理标题含关键字的试卷？[回车=不限]: ")).trim();
  if (kw) args.only = kw;

  const startNew = (await ask(paint("  包含未开始试卷并自动点开始？(y/N): ", C.yellow))).trim().toLowerCase();
  args.startNewQuiz = startNew === "y" || startNew === "yes";

  const todo = (await ask("  只处理待做试卷、跳过已得分？(Y/n): ")).trim().toLowerCase();
  if (todo === "n" || todo === "no") {
    const yes = (await ask(paint("  这会包含已得分/已完成试卷并覆盖已有答案，确认？(y/N): ", C.yellow))).trim().toLowerCase();
    if (yes === "y" || yes === "yes") {
      args.todo = false;
      args.force = true;
    }
  }

  const mx = (await ask("  最多处理几份试卷？[回车=不限，建议先填 1 试跑]: ")).trim();
  if (mx) { const n = Number.parseInt(mx, 10); if (n > 0) args.maxHomeworks = n; }

  if (!(await chooseQuizMode(args))) return;
  if (!args.noLlm && !(await ensureApi(args))) return;

  const logger = createLogger(args.outDirAbs);
  const quizShotDir = resolve(args.outDirAbs, "quiz-shots");
  await mkdir(quizShotDir, { recursive: true });
  const page = context.pages()[0] || (await context.newPage());
  console.log(paint("  进入成绩单、遍历新版试卷……", C.dim));
  const res = await runQuizPapers(args, context, page, logger, quizShotDir, url);
  const sum = logger.summary();
  const logPath = await logger.save();
  console.log("");
  console.log(
    paint(
      `  完成：处理试卷 ${res.doneCount}/${res.planned} 份 | 自动交卷 ${res.submittedCount || 0} | 题目 ${res.problemCount} | 已填写/点选 ${sum.clicked} | 失败 ${sum.failed}`,
      C.green + C.bold,
    ),
  );
  if (!args.submit && !args.dryRun && !args.noLlm) console.log(paint("  （未最终交卷，请在浏览器核对后手动交卷）", C.yellow));
  console.log(paint(`  日志: ${logPath}`, C.dim));
  console.log(paint(`  题面截图: ${quizShotDir}`, C.dim));
}

// 自动刷课：不需要 API Key。问 URL + 倍速/静音/讨论/上限，调 runWatch。
async function doWatch(args, context) {
  const url = (await ask(paint("  粘贴【学习内容/成绩单页】URL（含 /studentLog/）: ", C.bold))).trim();
  if (!url) { console.log(paint("  未输入，返回。", C.yellow)); return; }

  const sp = (await ask("  视频倍速 [默认 2]: ")).trim();
  if (sp) { const n = Number.parseFloat(sp); if (n > 0) args.speed = n; }
  const mu = (await ask("  静音播放？(Y/n): ")).trim().toLowerCase();
  args.mute = mu !== "n" && mu !== "no";
  const dz = (await ask(paint("  讨论环节自动复制最新评论发送？(y/N): ", C.yellow))).trim().toLowerCase();
  args.discuss = dz === "y" || dz === "yes";
  const mx = (await ask("  最多刷几个单元？[回车=不限，建议先填 1 试跑]: ")).trim();
  if (mx) { const n = Number.parseInt(mx, 10); if (n > 0) args.maxUnits = n; }

  const logger = createLogger(args.outDirAbs);
  console.log(
    paint(
      `  开始刷课：倍速 ${args.speed}x | ${args.mute ? "静音" : "有声"} | 讨论自动发言:${args.discuss ? "开" : "关"}`,
      C.dim,
    ),
  );
  const page = context.pages()[0] || (await context.newPage());
  const res = await runWatch(args, context, page, logger, url);
  console.log(
    paint(`  完成单元 ${res.done} | 跳过 ${res.skipped} | 失败 ${res.failed} | 共枚举 ${res.total}`, C.green + C.bold),
  );
  const logPath = await logger.save();
  console.log(paint(`  日志: ${logPath}`, C.dim));
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

  if (args.apiKey) {
    console.log(paint(`  ✓ API 已配置（${args.apiBase}，模型 ${args.model}）`, C.green));
  } else {
    console.log(paint("  （未配置 API：可直接用『3) 自动刷课』；做题功能在进入时再配置即可）", C.dim));
  }

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
    console.log("    3) 新版试卷（studentQuiz，填空/选择，待做连续处理）");
    console.log("    4) 自动刷课（看视频/图文，已完成自动跳过；可选讨论自动发言）");
    console.log("    5) 切换模型  当前: " + paint(args.model, C.cyan));
    console.log("    6) 重新登录 / 检查登录");
    console.log("    7) 重新配置 API（换服务商 / 模型 / Key）");
    console.log("    0) 退出");
    const ch = (await ask("  选择: ")).trim();
    try {
      if (ch === "1") await doSingle(args, context, shotDir);
      else if (ch === "2") await doCourse(args, context, shotDir);
      else if (ch === "3") await doQuiz(args, context);
      else if (ch === "4") await doWatch(args, context);
      else if (ch === "5") {
        const m = (await ask("  输入模型 ID（回车保持不变）: ")).trim();
        if (m) { args.model = m; console.log(paint("  已切换到 " + m, C.green)); }
      } else if (ch === "6") await openLogin(context);
      else if (ch === "7") await setupProvider(args, true);
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
