// 课程批量模式（命令行入口）：遍历整门课作业，可选自动提交。
// 用法：node src/course.mjs --submit --open-url "<学习日志/成绩单页URL>"
//   --only "第X章" 只做某份；--force 连已完成的也重做；不带 --submit 只勾选不提交。

import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { parseArgs, requireApiKey } from "./config.mjs";
import { launchBrowser, closeBrowser } from "./browser.mjs";
import { createLogger } from "./logger.mjs";
import { runCourse } from "./course-loop.mjs";

async function main() {
  const args = parseArgs();
  if (args.help || !args.openUrl) {
    console.log('用法: node src/course.mjs --submit --open-url "<学习日志/成绩单页URL>"');
    console.log("  --only \"第X章\" 只做某份；--force 连已完成的也重做；不带 --submit 只勾选不提交。");
    return;
  }
  requireApiKey(args);

  const logger = createLogger(args.outDirAbs);
  const shotDir = resolve(args.outDirAbs, "shots");
  await mkdir(shotDir, { recursive: true });

  logger.note(`课程批量模式 | ${args.submit ? "自动提交" : "只勾选不提交"} | 模型: ${args.model}`);
  logger.note(args.cdp ? `接管 Chrome（CDP: ${args.cdp}）……` : "启动独立配置档 Chrome……");
  const { context } = await launchBrowser(args);
  const listPage = context.pages()[0] || (await context.newPage());

  const { doneCount, planned } = await runCourse(args, context, listPage, logger, shotDir, args.openUrl);

  const sum = logger.summary();
  const logPath = await logger.save();
  logger.note("\n==================== 全部完成 ====================");
  logger.note(
    `处理作业: ${doneCount}/${planned} | 累计题: ${sum.total} | 已勾选: ${sum.clicked} | 已提交: ${sum.submitted} | 失败: ${sum.failed}`,
  );
  logger.note(`日志: ${logPath}`);
  logger.note(`题目截图: ${shotDir}`);
  logger.note("====================================================");

  if (args.exitWhenDone) await closeBrowser(context);
  else {
    logger.note("（浏览器保持打开。可直接关窗或 Ctrl+C 结束。）");
    await new Promise(() => {});
  }
}

main().catch((e) => {
  console.error("course 运行失败:", e.message);
  process.exitCode = 1;
});
