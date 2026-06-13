// 单份作业的答题循环 + DOM 辅助函数。
// run.mjs（单作业）和 course.mjs（遍历全部章节）共用这里的 answerHomework。

import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { extractInPage, readProgressInPage } from "./extract.mjs";
import { solveQuestion } from "./llm.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 关掉首屏的“我知道了”等弹窗（best-effort）。
export async function dismissPopups(page) {
  for (const name of ["我知道了", "知道了", "我知道啦"]) {
    try {
      const btn = page.getByText(name, { exact: false }).first();
      if (await btn.isVisible({ timeout: 400 })) {
        await btn.click({ timeout: 1000 });
        await sleep(200);
      }
    } catch {
      /* ignore */
    }
  }
}

// 在所有雨课堂标签页里找一个“当前能提取到题目”的页面。
export async function findQuestionPage(context, args) {
  for (const p of context.pages()) {
    if (!(p.url() || "").includes(args.urlContains)) continue;
    try {
      const q = await p.evaluate(extractInPage);
      if (q.ok && q.options.length) return { page: p, q };
    } catch {
      /* 页面可能在导航 */
    }
  }
  return null;
}

// 等待出现可作答的题目页（用户登录/导航期间）。
export async function waitForQuestionPage(context, args, logger) {
  let ticks = 0;
  for (;;) {
    const found = await findQuestionPage(context, args);
    if (found) return found;
    if (ticks % 8 === 0) {
      logger.note("等待中：请在弹出的 Chrome 里登录雨课堂并打开一份作业题目页……");
    }
    ticks += 1;
    await sleep(1500);
  }
}

// 截当前题的图，返回 base64。失败则退回截可视区域。
async function screenshotQuestion(page) {
  try {
    const loc = page.locator('[data-aa-q="1"]');
    if (await loc.count()) {
      const buf = await loc.screenshot();
      return buf.toString("base64");
    }
  } catch {
    /* fall through */
  }
  const buf = await page.screenshot({ fullPage: false });
  return buf.toString("base64");
}

// 稳健点击一个选项（滚动到可视区 → 普通点击 → 失败则 force 点击）。返回是否点上。
async function clickOptionByAaId(page, aaId) {
  const loc = page.locator(`[data-aa-id="${aaId}"]`);
  await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  try {
    await loc.click({ timeout: 6000 });
    return true;
  } catch {
    try {
      await loc.click({ timeout: 4000, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

// 勾选答案。single/judge 点目标项；multiple 逐项 toggle 到目标状态。
async function applyAnswer(page, q, answerLetters) {
  const want = new Set(answerLetters);
  if (q.type === "multiple") {
    for (const o of q.options) {
      const shouldCheck = want.has(o.letter);
      if (o.checked !== shouldCheck) {
        await clickOptionByAaId(page, o.aaId);
        await sleep(150);
      }
    }
  } else {
    const target = q.options.find((o) => want.has(o.letter));
    if (target) await clickOptionByAaId(page, target.aaId);
    await sleep(150);
  }
}

// 翻到下一题。返回 'next' | 'last' | 'nobtn'。
async function goNext(page, prevText) {
  const btn = page.getByRole("button", { name: "下一题" });
  if ((await btn.count()) === 0) return "nobtn";
  if (await btn.isDisabled().catch(() => false)) return "last";
  await btn.click({ timeout: 5000 }).catch(() => {});
  const start = Date.now();
  while (Date.now() - start < 5000) {
    await sleep(300);
    const text = await page.locator('[data-aa-q="1"]').innerText().catch(() => "");
    const cur = await page.evaluate(extractInPage).catch(() => null);
    if (cur && cur.ok && text && text !== prevText) return "next";
  }
  return "next";
}

// 等待题干变化（判断提交后是否自动翻页）。
async function waitStemChange(page, prevText, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(300);
    await page.evaluate(extractInPage).catch(() => null); // 重新打标签
    const text = await page.locator('[data-aa-q="1"]').innerText().catch(() => "");
    if (text && text !== prevText) return true;
  }
  return false;
}

// 处理提交后的确认弹窗。普通确认自动点；疑似“整卷交卷”保守不点。
async function handleConfirmDialog(page) {
  const dlg = page.locator(".el-message-box, .el-dialog__wrapper, [role=dialog]").first();
  const visible = await dlg.isVisible({ timeout: 800 }).catch(() => false);
  if (!visible) return null;
  const text = (await dlg.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 120);
  if (/交卷|全部提交|结束作业|结束考试|提交试卷/.test(text)) {
    return { text, action: "未自动确认(疑似整卷提交)" };
  }
  for (const name of ["确定", "确认", "是", "好的", "提交"]) {
    const b = dlg.getByRole("button", { name, exact: true }).first();
    if ((await b.count().catch(() => 0)) && (await b.isVisible().catch(() => false))) {
      await b.click({ timeout: 2000 }).catch(() => {});
      return { text, action: `点了「${name}」` };
    }
  }
  return { text, action: "有弹窗但未匹配确认按钮" };
}

// 点“提交”（主按钮），处理弹窗。返回 { ok, reason, dialog }。
async function submitQuestion(page, settleMs) {
  // 双保险：提交前再确认确实有选项被选中，否则绝不提交（防止空交）
  const cur = await page.evaluate(extractInPage).catch(() => null);
  if (!cur || !cur.options || !cur.options.some((o) => o.checked)) {
    return { ok: false, reason: "未检测到已选项，跳过提交（防空交）" };
  }
  const submit = page.locator("button.el-button--primary").filter({ hasText: "提交" }).first();
  if ((await submit.count()) === 0) return { ok: false, reason: "无提交按钮" };
  for (let i = 0; i < 12; i += 1) {
    if (!(await submit.isDisabled().catch(() => true))) break;
    await sleep(200);
  }
  if (await submit.isDisabled().catch(() => true)) {
    return { ok: false, reason: "提交按钮不可用(未选?)" };
  }
  await submit.click({ timeout: 5000 }).catch(() => {});
  await sleep(settleMs);
  const dialog = await handleConfirmDialog(page);
  await sleep(400);
  return { ok: true, dialog };
}

// 对 page 所在的这份作业，用侧边栏题号(1..N)逐题确定性遍历作答。
// 每题恰好处理一次：跳过已锁定/已答的；其余截图→模型→勾选→（可选）提交。
// 返回 { total }。labelPrefix 用于日志题号前缀（如“第四章#”）。
export async function answerHomework(args, context, page, logger, shotDir, labelPrefix = "") {
  let total = await page.evaluate(() => document.querySelectorAll(".J_order").length).catch(() => 0);
  if (!total) {
    const p = await page.evaluate(readProgressInPage).catch(() => ({}));
    total = p.total || 0;
  }
  if (!total) total = Math.min(args.maxQuestions, 40);
  total = Math.min(total, args.maxQuestions);
  logger.note(`总题数=${total}（侧边栏导航）`);

  for (let n = 1; n <= total; n += 1) {
    const idx = `${labelPrefix}${n}`;

    // 用侧边栏跳到第 n 题
    let navOk = false;
    for (let r = 0; r < 3 && !navOk; r += 1) {
      try {
        await page.locator(".J_order").nth(n - 1).click({ timeout: 5000 });
        navOk = true;
      } catch {
        await sleep(800);
      }
    }
    await sleep(args.clickSettleMs + 300);

    // 等当前题渲染出选项
    let q = null;
    for (let i = 0; i < 8; i += 1) {
      q = await page.evaluate(extractInPage).catch(() => null);
      if (q && q.ok && q.options.length) break;
      await sleep(700);
    }

    if (!q || !q.ok || !q.options.length) {
      logger.logQuestion({
        index: idx,
        type: "?",
        stem: "(非选择题/未识别)",
        options: [],
        answer: [],
        clicked: false,
        skipped: true,
        error: "非选择题(可能填空/简答)，跳过",
      });
      continue;
    }

    const letters = q.options.map((o) => o.letter);
    const shouldSkip = (args.submit ? q.locked : q.answered) && !args.force;
    if (shouldSkip) {
      logger.logQuestion({
        index: idx,
        type: q.type,
        stem: q.header,
        options: letters,
        answer: q.options.filter((o) => o.checked).map((o) => o.letter),
        clicked: false,
        skipped: true,
        dryRun: args.dryRun,
      });
      continue;
    }

    const imageBase64 = await screenshotQuestion(page);
    await writeFile(
      resolve(shotDir, `q-${String(idx).replace(/[^\w-]/g, "_")}.png`),
      Buffer.from(imageBase64, "base64"),
    ).catch(() => {});

    const res = await solveQuestion(args, {
      type: q.type,
      options: letters.map((l) => ({ label: l })),
      imageBase64,
    });

    let clicked = false;
    let actualChecked = [];
    let error = res.ok ? "" : res.error;
    let submitInfo;

    if (res.ok && !args.dryRun) {
      try {
        await applyAnswer(page, q, res.answer);
        await sleep(args.delayMs);
        const after = await page.evaluate(extractInPage).catch(() => null);
        actualChecked = after?.options?.filter((o) => o.checked).map((o) => o.letter) || [];
        const want = [...res.answer].sort().join("");
        const got = [...actualChecked].sort().join("");
        clicked = got === want;
        if (!clicked) error = `点击后选中=${got || "空"}，期望=${want}`;
      } catch (e) {
        error = `点击失败: ${e.message}`;
      }
    }

    if (args.submit && !args.dryRun && clicked) {
      const sres = await submitQuestion(page, args.clickSettleMs);
      submitInfo = sres.ok
        ? `已提交${sres.dialog ? `·弹窗(${sres.dialog.action})` : ""}`
        : `提交失败:${sres.reason}`;
      if (!sres.ok && !error) error = submitInfo;
    }

    logger.logQuestion({
      index: idx,
      type: q.type,
      stem: q.header,
      options: letters,
      answer: res.answer,
      reason: res.reason,
      clicked,
      actualChecked,
      submitted: !!(submitInfo && submitInfo.startsWith("已提交")),
      submitInfo,
      dryRun: args.dryRun,
      error: error || undefined,
      raw: res.ok ? undefined : res.raw,
    });

    await sleep(args.delayMs);
  }

  const prog = await page.evaluate(readProgressInPage).catch(() => ({}));
  if (prog.answeredCount != null) {
    logger.note(`本份作业进度：已提交 ${prog.answeredCount}/${prog.total || total}`);
  }
  return { total };
}
