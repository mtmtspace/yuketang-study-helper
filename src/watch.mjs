// 自动刷课（命令行入口）：进入「学习内容」，逐个看视频/图文，已完成自动跳过，
// 视频 2x+静音，看完自动切下一个；可选 --discuss 复制讨论区最新评论原样发送。答题不在此处理。
//
// 用法：node src/watch.mjs --open-url "<学习内容/studentLog 页URL>"
//   --speed 2          倍速（默认 2）
//   --no-mute          不静音（默认静音）
//   --only-chapter "第一章"  只刷标题含该关键字的章节
//   --discuss          讨论环节自动复制最新评论发送（默认关）
//   --max-units N      最多刷 N 个学习单元（先试少量）
//   --watch-poll 3000  完成度轮询间隔(ms)

import { parseArgs } from "./config.mjs";
import { launchBrowser, closeBrowser } from "./browser.mjs";
import { createLogger } from "./logger.mjs";
import { runWatch } from "./watch-loop.mjs";

async function main() {
  const args = parseArgs();
  if (args.help || !args.openUrl) {
    console.log('用法: node src/watch.mjs --open-url "<学习内容/studentLog 页URL>"');
    console.log('  --speed 2 倍速；--no-mute 不静音；--only-chapter "第X章" 只刷某章；');
    console.log("  --discuss 讨论区自动复制最新评论发送；--max-units N 最多刷N个单元；--watch-poll ms 轮询间隔。");
    return;
  }

  const logger = createLogger(args.outDirAbs);
  logger.note(
    `自动刷课 | 倍速 ${args.speed}x | ${args.mute ? "静音" : "有声"} | 讨论自动发言:${args.discuss ? "开" : "关"}` +
      `${args.maxUnits ? ` | 限 ${args.maxUnits} 个单元` : ""}${args.onlyChapter ? ` | 仅“${args.onlyChapter}”` : ""}`,
  );
  logger.note(args.cdp ? `接管 Chrome（CDP: ${args.cdp}）……` : "启动独立配置档 Chrome……");
  const { context } = await launchBrowser(args);
  const listPage = context.pages()[0] || (await context.newPage());

  const res = await runWatch(args, context, listPage, logger, args.openUrl);

  const logPath = await logger.save();
  logger.note("\n==================== 刷课结束 ====================");
  logger.note(
    `完成单元: ${res.done} | 跳过(已完成/不支持): ${res.skipped} | 失败: ${res.failed} | 共枚举: ${res.total}`,
  );
  logger.note(`日志: ${logPath}`);
  logger.note("==================================================");

  if (args.exitWhenDone) await closeBrowser(context);
  else {
    logger.note("（浏览器保持打开。可直接关窗或 Ctrl+C 结束。）");
    await new Promise(() => {});
  }
}

main().catch((e) => {
  console.error("watch 运行失败:", e.message);
  process.exitCode = 1;
});
