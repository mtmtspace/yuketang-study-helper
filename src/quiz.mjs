// 新版「试卷」模块入口：从 studentLog 成绩单枚举“试卷”，处理 studentQuiz 填空题。
// 默认只保存答案，不点击最终“交卷”。

import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { parseArgs, requireApiKey } from "./config.mjs";
import { launchBrowser, closeBrowser } from "./browser.mjs";
import { createLogger } from "./logger.mjs";
import { runQuizPapers } from "./quiz-loop.mjs";
import { usesAgentSolver } from "./agent-io.mjs";

async function main() {
  const args = parseArgs();
  if (args.help || !args.openUrl) {
    printHelp();
    return;
  }
  const hasManualAnswers = args.answers && args.answers.length > 0;
  if (!args.noLlm && !hasManualAnswers && !usesAgentSolver(args)) requireApiKey(args);

  const logger = createLogger(args.outDirAbs);
  const shotDir = resolve(args.outDirAbs, "quiz-shots");
  await mkdir(shotDir, { recursive: true });

  logger.note(
    `试卷填空模式 | ${
      args.noLlm
        ? "no-llm（只验证页面/截图/填空框）"
        : args.agentDump
          ? "agent-dump（只导出截图/题目，不请求模型、不填写）"
          : args.answersFile
            ? `agent answers-file（读取 ${args.answersFile} 回填）`
            : hasManualAnswers
              ? `manual（使用 --answers 的 ${args.answers.length} 个答案）`
              : args.dryRun
                ? "dry-run（只截图问模型，不填写）"
                : args.submit
                  ? "填写并自动交卷"
                  : "填写并保存（不交卷）"
    }${args.noLlm || hasManualAnswers || usesAgentSolver(args) ? "" : ` | 模型: ${args.model}`}`,
  );
  if (args.submit) logger.note("注意：quiz 模式已启用 --submit，会在每份试卷处理完后点击最终交卷。");
  logger.note(args.cdp ? `接管 Chrome（CDP: ${args.cdp}）……` : "启动独立配置档 Chrome……");

  const { context, page } = await launchBrowser(args);
  const listPage = page || (await context.newPage());
  const res = await runQuizPapers(args, context, listPage, logger, shotDir, args.openUrl);

  const sum = logger.summary();
  const logPath = await logger.save();
  logger.note("\n==================== 试卷模块完成 ====================");
  logger.note(
    `处理试卷: ${res.doneCount}/${res.planned} | 自动交卷: ${res.submittedCount || 0} | 题目: ${res.problemCount} | 已填写/点选: ${sum.clicked} | 失败: ${sum.failed}`,
  );
  logger.note(`日志: ${logPath}`);
  logger.note(`题面截图: ${shotDir}`);
  logger.note(
    args.agentDump
      ? "Agent dump 只导出题目，未填写、未交卷。"
      : args.submit
        ? "已按 --submit 尝试自动交卷。"
        : "未点击最终“交卷”。请在浏览器里核对后手动交卷。",
  );
  logger.note("======================================================");

  if (args.exitWhenDone) await closeBrowser(context);
  else {
    logger.note("（浏览器保持打开。检查完成后可直接关闭窗口，或 Ctrl+C 结束。）");
    await new Promise(() => {});
  }
}

function printHelp() {
  console.log(`
雨课堂学习助手（新版试卷）

用法:
  node src/quiz.mjs --open-url "<学习日志/studentLog 页URL>"

常用:
  npm run quiz -- --open-url "<学习日志页URL>" --only "T or F questions chap 3" --max-homeworks 1

选项:
  --dry-run             只截图问模型并记录答案，不填写
  --no-llm              只验证页面/截图/填空框，不请求模型、不填写
  --agent-dump          给 Agent 用：导出题目截图/结构，不请求模型、不填写
  --answers-file <f>    给 Agent 用：读取 JSON 答案文件并回填
  --answers <list>      人工答案覆盖，逗号分隔或 JSON 数组；不请求模型
  --only <关键字>        只处理标题含关键字的试卷
  --max-homeworks <n>   最多处理 n 份试卷
  --todo                只处理待做试卷：进行中；配合 --start-new-quiz 时包含未开始
  --force               包含非“进行中”的试卷，并覆盖已有填空
  --start-new-quiz      允许启动“未开始”试卷（可能开始计时）
  --submit              每份试卷处理完后自动点击最终交卷（慎用）
  --model <name>        模型（需支持视觉/读图）
  --api-base <url>      API Base
  --exit-when-done      做完后关闭浏览器

说明:
  - 当前模块针对 studentQuiz：填空题走题内保存；单选/多选/判断先复用旧作业选择题结构。
  - 默认只填写/点选，不会点击最终“交卷”；传 --submit 才会自动交卷。
`);
}

main().catch((e) => {
  console.error("quiz 运行失败:", e.message);
  process.exitCode = 1;
});
