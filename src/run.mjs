// 单份作业入口：启动/接管浏览器 → 定位作业题目页 → 作答（可选自动提交）。
// 真正的答题循环在 answer-loop.mjs，course.mjs 也复用它。

import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { parseArgs, requireApiKey } from "./config.mjs";
import { launchBrowser, findYuketangPage, closeBrowser } from "./browser.mjs";
import { createLogger } from "./logger.mjs";
import { sleep, dismissPopups, waitForQuestionPage, answerHomework } from "./answer-loop.mjs";
import { usesAgentSolver } from "./agent-io.mjs";

async function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    return;
  }
  if (!usesAgentSolver(args)) requireApiKey(args);

  const logger = createLogger(args.outDirAbs);
  const shotDir = resolve(args.outDirAbs, "shots");
  await mkdir(shotDir, { recursive: true });

  const modeText = args.dryRun
    ? "dry-run（只读不点选）"
    : args.agentDump
      ? "Agent dump（只截图导出，不调用模型、不点选）"
      : args.answersFile
        ? "Agent answers-file（读取 Agent 答案并回填）"
        : args.submit
          ? "作答 + 自动提交（每题选完即交、自动翻页）"
          : "作答（勾选，不提交）";
  logger.note(`模式: ${modeText}${usesAgentSolver(args) ? "" : ` | 模型: ${args.model}`}`);
  logger.note(
    args.cdp
      ? `接管已打开的 Chrome（CDP: ${args.cdp}）……`
      : "启动带登录态的 Chrome（独立配置档）……",
  );
  const { context } = await launchBrowser(args);

  if (args.openUrl) {
    const p =
      findYuketangPage(context, args.urlContains) ||
      context.pages()[0] ||
      (await context.newPage());
    logger.note(`打开作业页: ${args.openUrl}`);
    await p
      .goto(args.openUrl, { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch((e) => logger.note(`打开失败（可手动导航）: ${e.message}`));
    await sleep(1500);
    await dismissPopups(p).catch(() => {});
  }

  const initialPage = findYuketangPage(context, args.urlContains);
  if (initialPage) await dismissPopups(initialPage).catch(() => {});

  let { page } = await waitForQuestionPage(context, args, logger);
  await dismissPopups(page).catch(() => {});

  if (args.startQuestion && args.startQuestion >= 1) {
    logger.note(`跳到第 ${args.startQuestion} 题…`);
    try {
      await page.locator(".J_order").nth(args.startQuestion - 1).click({ timeout: 5000 });
      await sleep(1500);
    } catch (e) {
      logger.note(`跳题失败（忽略，从当前题开始）：${e.message}`);
    }
  }

  await answerHomework(args, context, page, logger, shotDir);

  const sum = logger.summary();
  const logPath = await logger.save();
  logger.note("");
  logger.note("==================== 完成 ====================");
  if (args.submit) {
    logger.note(`处理题数: ${sum.total} | 已勾选: ${sum.clicked} | 已提交: ${sum.submitted} | 失败: ${sum.failed}`);
  } else {
    logger.note(`处理题数: ${sum.total} | 已勾选: ${sum.clicked} | 失败: ${sum.failed}`);
  }
  logger.note(`日志: ${logPath}`);
  logger.note(`题目截图: ${shotDir}`);
  logger.note(
    args.submit
      ? "已按题自动提交（若有“整卷交卷”弹窗未自动点，请在浏览器手动确认）。建议仍核对结果。"
      : "⚠️ 全程未提交。请在浏览器里逐题检查无误后，自行点“提交/交卷”。",
  );
  logger.note("==============================================");

  if (args.exitWhenDone) {
    await closeBrowser(context);
  } else {
    logger.note("（浏览器保持打开。检查完成后可直接关闭窗口，或在此终端按 Ctrl+C 结束。）");
    await new Promise(() => {}); // 挂起，保持浏览器开着
  }
}

function printHelp() {
  console.log(`
雨课堂学习助手（单份作业）

用法:
  node src/run.mjs [选项]

选项:
  --submit             每题选完自动点“提交”并自动翻页（默认不提交）
  --cdp <url>          接管你已带调试端口启动的 Chrome，如 http://127.0.0.1:9222
  --dry-run            只提取+问模型+记录，不点选
  --agent-dump         给 Agent 用：只截图导出题目，不请求模型、不点选
  --answers-file <f>   给 Agent 用：读取 JSON 答案文件并回填
  --force              已答过/已交过的题也重新处理
  --max-questions <n>  最多处理题数（默认 200）
  --start-question <n> 从第 n 题开始（跳题/续答）
  --open-url <url>     启动后直接打开该作业页
  --model <name>       方舟模型（需支持视觉/读图）
  --api-base <url>     方舟 API Base
  --delay <ms>         每步间隔毫秒（默认 600）
  --url-contains <s>   目标标签页 URL 关键字（默认 yuketang.cn）
  --exit-when-done     做完后自动关闭/断开（默认保持打开）
  -h, --help           显示帮助

说明:
  - API Key 取环境变量 ARK_API_KEY（或 .env）。
  - 题干/选项是加密字体，靠“截图+视觉模型”识别，故模型必须支持读图。
  - 遍历全部章节作业请用 course.mjs。
`);
}

main().catch((e) => {
  console.error("运行失败:", e.message);
  process.exitCode = 1;
});
