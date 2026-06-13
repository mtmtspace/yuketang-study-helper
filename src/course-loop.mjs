// 课程批量编排：从「成绩单」遍历作业，逐个打开 → answerHomework → 关闭。
// course.mjs（命令行）和 cli.mjs（交互式 TUI）共用 runCourse。

import { resolve } from "node:path";
import { extractInPage } from "./extract.mjs";
import { sleep, dismissPopups, answerHomework } from "./answer-loop.mjs";

// 在成绩单页里收集所有“作业”项：{ title, status }。
export function collectHomeworksInPage() {
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const map = new Map();
  for (const el of document.querySelectorAll("tr, li, div, section, p")) {
    const t = norm(el.innerText);
    if (!t || t.length > 140) continue;
    if (!(t.includes("作业") && /第[一-龥\d]+章/.test(t))) continue;
    if (!/(未开始|已完成|进行中|已截止|\d\s*\/\s*\d)/.test(t)) continue;
    const title = t
      .replace(/作业/g, "")
      .replace(/[：:]/g, "")
      .replace(/\s*\d{4}-\d{2}-\d{2}.*$/, "")
      .replace(/\s*-\s*-\s*.*$/, "")
      .replace(/\s*(未开始|已完成|进行中|已截止).*$/, "")
      .trim();
    const status = (t.match(/未开始|已完成|进行中|已截止/) || ["?"])[0];
    if (title && title.length >= 4 && !map.has(title)) map.set(title, status);
  }
  return [...map.entries()].map(([title, status]) => ({ title, status }));
}

async function gotoGradeList(page, listUrl) {
  await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await sleep(3000);
  await page.getByText("成绩单", { exact: true }).first().click({ timeout: 8000 }).catch(() => {});
  await sleep(4000);
}

async function waitReady(page) {
  for (let i = 0; i < 12; i += 1) {
    const q = await page.evaluate(extractInPage).catch(() => null);
    if (q && q.ok && q.options.length) return true;
    await dismissPopups(page).catch(() => {});
    await sleep(1500);
  }
  return false;
}

/**
 * 遍历整门课作业。listPage 为「学习日志/成绩单」所在标签页。
 * 返回 { doneCount, planned, homeworks }。
 */
export async function runCourse(args, context, listPage, logger, shotDir, listUrl) {
  await gotoGradeList(listPage, listUrl);
  const homeworks = await listPage.evaluate(collectHomeworksInPage).catch(() => []);
  logger.note(`发现作业 ${homeworks.length} 份：`);
  for (const h of homeworks) logger.note(`  - [${h.status}] ${h.title}`);

  const targets = args.only
    ? homeworks.filter((h) => h.title.includes(args.only))
    : args.force
      ? homeworks
      : homeworks.filter((h) => h.status !== "已完成");
  const limited = args.maxHomeworks > 0 ? targets.slice(0, args.maxHomeworks) : targets;
  logger.note(
    `将处理 ${limited.length} 份（${args.only ? `匹配“${args.only}”` : args.force ? "全部" : "未完成"}${args.maxHomeworks > 0 ? `，限 ${args.maxHomeworks} 份` : ""}）。\n`,
  );

  let doneCount = 0;
  for (const hw of limited) {
    logger.note(`===== 开始：${hw.title}（${hw.status}）=====`);
    await gotoGradeList(listPage, listUrl);

    const tagged = await listPage.evaluate((title) => {
      const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
      const rows = [...document.querySelectorAll("tr, li, div, section, p")].filter((el) => {
        const t = norm(el.innerText);
        return t.includes("作业") && t.includes(title) && t.length < 170 && el.children.length <= 14;
      });
      rows.sort((a, b) => a.innerText.length - b.innerText.length);
      document.querySelectorAll("[data-open-hw]").forEach((e) => e.removeAttribute("data-open-hw"));
      if (!rows[0]) return false;
      rows[0].setAttribute("data-open-hw", "1");
      return true;
    }, hw.title);

    if (!tagged) {
      logger.note("  未找到该作业行，跳过。");
      continue;
    }

    const newPagePromise = context.waitForEvent("page", { timeout: 15000 }).catch(() => null);
    await listPage.click('[data-open-hw="1"]', { timeout: 5000 }).catch((e) => logger.note("  点行失败: " + e.message));

    let exPage = await newPagePromise;
    if (!exPage || !/exercise/i.test(exPage.url())) {
      await sleep(3000);
      exPage = context.pages().find((p) => /exercise/i.test(p.url())) || null;
    }
    if (!exPage) {
      logger.note("  未打开作业页，跳过。");
      continue;
    }

    await exPage.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(2500);
    await dismissPopups(exPage).catch(() => {});
    if (!(await waitReady(exPage))) {
      logger.note("  作业页题目未就绪，跳过。");
      if (exPage !== listPage) await exPage.close().catch(() => {});
      continue;
    }

    await answerHomework(args, context, exPage, logger, shotDir, `${hw.title.replace(/\s.*/, "")}#`);
    if (exPage !== listPage) await exPage.close().catch(() => {});
    doneCount += 1;
    await sleep(args.delayMs);
  }

  return { doneCount, planned: limited.length, homeworks };
}

// 给 cli.mjs 用：只列作业，不作答。
export async function listHomeworks(listPage, listUrl) {
  await gotoGradeList(listPage, listUrl);
  return listPage.evaluate(collectHomeworksInPage).catch(() => []);
}
