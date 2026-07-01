// studentQuiz/试卷 作答编排。
//
// 结构核验（2026-06-29，www.yuketang.cn 新版成绩单）：
// - 成绩单 tab: #tab-student_school_report
// - 试卷行: #pane-student_school_report li.study-unit，类型标签文本“试卷”
// - 打开后主 URL: /v2/web/studentQuiz/<quizId>/1?hide_return=1
// - 真实试卷在子 iframe: /v/quiz/quiz_result/<quizId>/
// - 填空题题面在 quiz iframe 的 .problem_item.FillBlank；题干多为图片/富文本，DOM 文本取不到，需截图给视觉模型
// - 点“作答”(.J_problem_blank) 后出现嵌套 iframe: /v/index/blanks/answer/quiz/<problemId>/<quizId>
// - 填空输入框: textarea.cont.text-input；保存按钮: .subjective__footer .btn
//
// 安全边界：默认只保存题目答案，不点击最终“去交卷/交卷”；传 submit 时才整卷提交。

import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { sleep, dismissPopups } from "./answer-loop.mjs";
import { extractInPage } from "./extract.mjs";
import { solveFillBlank, solveQuestion } from "./llm.mjs";
import { getAgentAnswer } from "./agent-io.mjs";

function sanitizeName(s) {
  return String(s || "")
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80);
}

function norm(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function paperText(p) {
  return `${p.status || ""} ${p.score || ""} ${p.text || ""}`;
}

function isPaperInProgress(p) {
  return /进行中/.test(paperText(p));
}

function isPaperNotStarted(p) {
  return /未开始|待开始|未作答/.test(paperText(p));
}

export function collectQuizPapersInPage() {
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const rows = [...document.querySelectorAll("#pane-student_school_report li.study-unit")];
  document.querySelectorAll("[data-quiz-paper-idx]").forEach((e) => e.removeAttribute("data-quiz-paper-idx"));
  return rows
    .map((row, idx) => {
      row.setAttribute("data-quiz-paper-idx", String(idx));
      const type = norm(
        row.querySelector(".unit-name-td .type, .unit-name-td .type_text, .unit-name-td span")?.innerText,
      );
      const title = norm(row.querySelector(".name-text")?.innerText || row.querySelector(".unit-name-td")?.innerText);
      const studyTime = norm(row.querySelector(".study-time-td")?.innerText);
      const status = norm(row.querySelector(".complete-td")?.innerText);
      const score = norm(row.querySelector(".score-td")?.innerText);
      const text = norm(row.innerText);
      return { idx, type, title, studyTime, status, score, text };
    })
    .filter((row) => row.type.includes("试卷") || row.text.startsWith("试卷 "));
}

async function gotoGradeTab(page, listUrl) {
  if (!/studentLog/.test(page.url())) {
    await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  }
  await sleep(2500);
  await dismissPopups(page).catch(() => {});
  await page.waitForSelector("#tab-student_school_report", { timeout: 15000 }).catch(() => {});
  const tab = page.locator("#tab-student_school_report").first();
  if (await tab.count().catch(() => 0)) {
    await tab.click({ timeout: 8000 }).catch(() => {});
  } else {
    await page.getByText("成绩单", { exact: true }).first().click({ timeout: 8000 }).catch(() => {});
  }
  await sleep(4000);
  await dismissPopups(page).catch(() => {});
}

async function openQuizPaper(listPage, paper) {
  const before = listPage.url();
  let popupPage = null;
  const popupPromise = listPage
    .context()
    .waitForEvent("page", { timeout: 15000 })
    .then(async (p) => {
      popupPage = p;
      await p.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      await sleep(1500);
      return p;
    })
    .catch(() => null);
  const row = listPage.locator(`[data-quiz-paper-idx="${paper.idx}"]`).first();
  const title = listPage
    .locator(`[data-quiz-paper-idx="${paper.idx}"] .unit-name-td, [data-quiz-paper-idx="${paper.idx}"] .name-text`)
    .first();
  await row.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  if (await title.count().catch(() => 0)) {
    await title.click({ timeout: 8000 }).catch(async () => {
      await row.click({ timeout: 8000, force: true }).catch(() => {});
    });
  } else {
    await row.click({ timeout: 8000, force: true }).catch(() => {});
  }
  await sleep(1000);

  if (listPage.url() === before && !popupPage) {
    await listPage
      .evaluate((idx) => {
        const esc = window.CSS && CSS.escape ? CSS.escape(String(idx)) : String(idx).replace(/[^\w-]/g, "\\$&");
        const row = document.querySelector(`[data-quiz-paper-idx="${esc}"]`);
        const target = row?.querySelector(".unit-name-td.hoverblue, .unit-name-td, .name-text") || row;
        if (target) {
          target.click();
          return true;
        }
        return false;
      }, paper.idx)
      .catch(() => false);
  }

  for (let i = 0; i < 20; i += 1) {
    await sleep(700);
    if (listPage.url() !== before || /studentQuiz/.test(listPage.url())) {
      await listPage.waitForLoadState("domcontentloaded").catch(() => {});
      await sleep(3000);
      return { ok: true, page: listPage };
    }
    if (popupPage && /studentQuiz/.test(popupPage.url())) {
      await popupPage.waitForLoadState("domcontentloaded").catch(() => {});
      await sleep(3000);
      return { ok: true, page: popupPage };
    }
  }
  const latePopup = await popupPromise;
  if (latePopup && /studentQuiz/.test(latePopup.url())) {
    await latePopup.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(3000);
    return { ok: true, page: latePopup };
  }
  return { ok: /studentQuiz/.test(listPage.url()), page: listPage };
}

async function quizFrame(page) {
  for (let i = 0; i < 20; i += 1) {
    const frame = page.frames().find((fr) => /\/v\/quiz\/quiz_result\//.test(fr.url()));
    if (frame) return frame;
    await sleep(800);
  }
  return null;
}

async function enterQuiz(page, args, logger, label) {
  const frame = await quizFrame(page);
  if (!frame) return { ok: false, reason: "未找到 quiz_result iframe" };

  const cover = await frame
    .evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 1 && r.height > 1 && st.display !== "none" && st.visibility !== "hidden";
      };
      const btn = document.querySelector("#check_quiz_btn");
      return btn && visible(btn) ? { text: (btn.innerText || "").trim() } : null;
    })
    .catch(() => null);

  if (cover) {
    if (/开始/.test(cover.text) && !args.startNewQuiz) {
      return { ok: false, reason: "试卷未开始；未传 --start-new-quiz，跳过以免启动计时" };
    }
    await frame.locator("#check_quiz_btn").click({ timeout: 8000 }).catch(() => {});
    await sleep(1500);
    const startDialog = await frame
      .evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 1 && r.height > 1 && st.display !== "none" && st.visibility !== "hidden";
        };
        const dlg = document.querySelector(".confirm_start_dialog");
        return dlg && visible(dlg) ? (dlg.innerText || "").replace(/\s+/g, " ").trim() : "";
      })
      .catch(() => "");
    if (startDialog) {
      if (!args.startNewQuiz) return { ok: false, reason: "出现开始计时确认弹窗，跳过" };
      await frame.locator(".confirm_start_dialog .J_button2").click({ timeout: 5000 }).catch(() => {});
    }
    logger.note(`    已进入试卷：${label}`);
    await sleep(5000);
  }

  return { ok: true, frame: await quizFrame(page) };
}

async function collectQuizProblems(frame) {
  return frame
    .evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 1 && r.height > 1 && st.display !== "none" && st.visibility !== "hidden";
      };
      const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
      const inferType = (el) => {
        const cls = String(el.className || "");
        const text = norm(el.innerText || "");
        if (/FillBlank|填空/i.test(cls) || /填空题/.test(text)) return "fillblank";
        if (/Multiple|Checkbox|多选|不定项/i.test(cls) || /多选题|不定项/.test(text)) return "multiple";
        if (/Judge|Judg|TrueFalse|判断/i.test(cls) || /判断题/.test(text)) return "judge";
        if (/Single|Radio|Choice|单选/i.test(cls) || /单选题/.test(text)) return "single";
        if (el.querySelector("label.el-checkbox, input[type=checkbox]")) return "multiple";
        if (el.querySelector("label.el-radio, input[type=radio]")) return "single";
        return "unknown";
      };
      return [...document.querySelectorAll(".problem_item, .subject-item")]
        .map((el, i) => {
          if (!el.id) el.id = `quiz-problem-${i + 1}`;
          el.setAttribute("data-quiz-problem-idx", String(i));
          const type = inferType(el);
          const header = (el.querySelector(".problem_type_box, .ptype")?.innerText || el.innerText || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80);
          const answered = !!el.querySelector(".J_problem_blank.completed");
          const optionCount = el.querySelectorAll("label.el-radio, label.el-checkbox").length;
          return {
            index: i + 1,
            id: el.id,
            selector: `[data-quiz-problem-idx="${i}"]`,
            type,
            header,
            answered,
            optionCount,
            visible: visible(el),
          };
        })
        .filter((x) => x.type === "fillblank" || x.optionCount > 0);
    })
    .catch(() => []);
}

async function screenshotProblem(frame, problem, shotDir, label) {
  const loc = frame.locator(problem.selector || `#${problem.id}`);
  await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await sleep(500);
  let buf = null;
  try {
    buf = await loc.screenshot();
  } catch {
    buf = await frame.page().screenshot({ fullPage: false });
  }
  const file = resolve(shotDir, `quiz-${sanitizeName(label)}-${problem.index}.png`);
  await writeFile(file, buf).catch(() => {});
  return { imageBase64: buf.toString("base64"), file };
}

async function openBlankFrame(page, frame, problem) {
  const root = problem.selector || `#${problem.id}`;
  await frame.locator(`${root} .J_problem_blank`).click({ timeout: 8000 }).catch(async () => {
    await frame.locator(root).click({ timeout: 8000, force: true }).catch(() => {});
  });
  for (let i = 0; i < 20; i += 1) {
    await sleep(700);
    const blank = page.frames().find((fr) => /\/v\/index\/blanks\/answer\/quiz\//.test(fr.url()));
    if (blank) return blank;
  }
  return null;
}

async function readBlankFields(blankFrame) {
  return blankFrame
    .evaluate(() =>
      [...document.querySelectorAll("textarea.cont.text-input, textarea, input[type=text]")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 1 && r.height > 1 && st.display !== "none" && st.visibility !== "hidden";
        })
        .map((el, index) => ({ index: index + 1, value: el.value || "" })),
    )
    .catch(() => []);
}

async function fillAndSaveBlankAnswers(args, blankFrame, answers) {
  const selector = "textarea.cont.text-input, textarea, input[type=text]";
  const fields = blankFrame.locator(selector);
  const count = await fields.count().catch(() => 0);
  let filled = 0;
  for (let i = 0; i < Math.min(count, answers.length); i += 1) {
    const loc = fields.nth(i);
    const current = await loc.inputValue().catch(() => "");
    if (!args.force && current.trim()) continue;
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await loc.fill(String(answers[i] ?? ""), { timeout: 5000 }).catch(async () => {
      await loc.click({ timeout: 2000 }).catch(() => {});
      await loc.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
      await loc.type(String(answers[i] ?? "")).catch(() => {});
    });
    filled += 1;
    await sleep(120);
  }
  const save = blankFrame.locator(".subjective__footer .btn, .btn").filter({ hasText: "保存" }).first();
  if (filled > 0 && (await save.count().catch(() => 0))) {
    await save.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await save.click({ timeout: 5000 }).catch(() => {});
    await sleep(1500);
  }
  return filled;
}

async function extractChoiceQuestion(frame, problem) {
  return frame.evaluate(extractInPage, { rootSelector: problem.selector }).catch((e) => ({
    ok: false,
    error: e.message || String(e),
  }));
}

async function clickChoiceOptionByAaId(frame, aaId) {
  const loc = frame.locator(`[data-aa-id="${aaId}"]`);
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

async function applyChoiceAnswer(frame, q, answerLetters) {
  const want = new Set(answerLetters);
  if (q.type === "multiple") {
    for (const o of q.options) {
      const shouldCheck = want.has(o.letter);
      if (o.checked !== shouldCheck) {
        await clickChoiceOptionByAaId(frame, o.aaId);
        await sleep(150);
      }
    }
  } else {
    const target = q.options.find((o) => want.has(o.letter));
    if (target) await clickChoiceOptionByAaId(frame, target.aaId);
    await sleep(150);
  }
}

function normalizeChoiceAnswers(values, validLetters) {
  const valid = new Set(validLetters);
  const out = [];
  for (const value of values || []) {
    const letters = String(value || "")
      .toUpperCase()
      .match(/[A-H]/g);
    for (const letter of letters || []) {
      if (valid.has(letter) && !out.includes(letter)) out.push(letter);
    }
  }
  return out.sort();
}

async function handleChoiceProblem(args, frame, problem, logger, shotDir, label) {
  const q = await extractChoiceQuestion(frame, problem);
  if (!q || !q.ok || !q.options?.length) {
    return {
      ok: false,
      error: q?.error || "未识别选择题结构",
      type: problem.type === "unknown" ? "choice" : problem.type,
    };
  }

  const letters = q.options.map((o) => o.letter);
  const existing = q.options.filter((o) => o.checked).map((o) => o.letter);
  if (q.answered && !args.force) {
    return {
      ok: true,
      type: q.type,
      answers: existing,
      options: letters,
      existing,
      skipped: true,
      reason: "已检测到选中项，未传 --force，跳过",
    };
  }

  const shot = await screenshotProblem(frame, problem, shotDir, label);
  if (args.agentDump) {
    return {
      ok: true,
      type: q.type,
      answers: [],
      options: letters,
      existing,
      inspectOnly: true,
      reason: "agent-dump：已导出选择题截图，等待 Agent 写 answers-file",
      shot: shot.file,
      answerFormat: q.type === "multiple" ? "choice letters array, e.g. [\"A\",\"C\"]" : "one choice letter, e.g. [\"B\"]",
    };
  }

  if (args.noLlm) {
    return {
      ok: true,
      type: q.type,
      answers: [],
      options: letters,
      existing,
      inspectOnly: true,
      reason: "no-llm：已截图并识别选择题结构，未请求模型",
      shot: shot.file,
    };
  }

  let solved;
  if (args.answersFile) {
    const agent = getAgentAnswer(args, {
      index: `${label}#${problem.index}`,
      shortIndex: problem.index,
      kind: "choice",
      type: q.type,
      validLetters: letters,
    });
    solved = agent.ok
      ? { ok: true, answer: agent.answers, reason: agent.reason, raw: agent.raw }
      : { ok: false, answer: [], error: agent.error };
  } else if (args.answers?.length) {
    const answer = normalizeChoiceAnswers(args.answers, letters);
    const validCount = q.type === "multiple" ? answer.length >= 1 : answer.length === 1;
    solved = validCount
      ? { ok: true, answer, reason: "manual：使用 --answers 人工选项覆盖，未请求模型" }
      : { ok: false, answer: [], error: `--answers 未给出有效${q.type === "multiple" ? "多选" : "单选"}字母` };
  } else {
    solved = await solveQuestion(args, {
      type: q.type,
      options: letters.map((l) => ({ label: l })),
      imageBase64: shot.imageBase64,
    });
  }

  if (!solved.ok) {
    return {
      ok: false,
      type: q.type,
      options: letters,
      error: solved.error || "模型未返回有效选项",
      raw: solved.raw,
      shot: shot.file,
      existing,
    };
  }

  let clicked = false;
  let actualChecked = existing;
  let error = "";
  if (!args.dryRun) {
    await applyChoiceAnswer(frame, q, solved.answer);
    await sleep(args.delayMs);
    const after = await extractChoiceQuestion(frame, problem);
    actualChecked = after?.options?.filter((o) => o.checked).map((o) => o.letter) || [];
    const want = [...solved.answer].sort().join("");
    const got = [...actualChecked].sort().join("");
    clicked = got === want;
    if (!clicked) error = `点击后选中=${got || "空"}，期望=${want}`;
  }

  return {
    ok: !error,
    type: q.type,
    answers: solved.answer,
    options: letters,
    existing,
    actualChecked,
    clicked,
    reason: solved.reason,
    raw: solved.raw,
    shot: shot.file,
    error: error || undefined,
  };
}

async function handleFillBlankProblem(args, page, frame, problem, logger, shotDir, label) {
  const shot = await screenshotProblem(frame, problem, shotDir, label);
  const blankFrame = await openBlankFrame(page, frame, problem);
  if (!blankFrame) {
    return { ok: false, error: "未打开填空答案 iframe", shot: shot.file };
  }
  const fields = await readBlankFields(blankFrame);
  const blankCount = fields.length;
  if (!blankCount) return { ok: false, error: "未找到填空输入框", shot: shot.file };
  if (args.agentDump) {
    return {
      ok: true,
      answers: [],
      reason: "agent-dump：已导出填空题截图和填空数量，等待 Agent 写 answers-file",
      filled: 0,
      blankCount,
      shot: shot.file,
      existing: fields.map((f) => f.value),
      inspectOnly: true,
      answerFormat: `fill answers array length ${blankCount}`,
    };
  }
  if (args.noLlm) {
    return {
      ok: true,
      answers: [],
      reason: "no-llm：已截图并读取填空框，未请求模型",
      filled: 0,
      blankCount,
      shot: shot.file,
      existing: fields.map((f) => f.value),
      inspectOnly: true,
    };
  }
  if (args.answersFile) {
    const agent = getAgentAnswer(args, {
      index: `${label}#${problem.index}`,
      shortIndex: problem.index,
      kind: "fill",
      expectedCount: blankCount,
    });
    if (!agent.ok) {
      return {
        ok: false,
        error: agent.error,
        shot: shot.file,
        existing: fields.map((f) => f.value),
      };
    }
    const answers = agent.answers.map((x) => String(x ?? "").trim());
    let filled = 0;
    let afterFields = fields;
    if (!args.dryRun) {
      filled = await fillAndSaveBlankAnswers(args, blankFrame, answers);
      afterFields = await readBlankFields(blankFrame);
    }
    return {
      ok: true,
      answers,
      reason: agent.reason,
      raw: agent.raw,
      filled,
      blankCount,
      shot: shot.file,
      existing: fields.map((f) => f.value),
      actualChecked: afterFields.map((f) => f.value),
    };
  }
  if (args.answers?.length) {
    if (args.answers.length !== blankCount) {
      return {
        ok: false,
        error: `--answers 数量(${args.answers.length})与填空数(${blankCount})不一致`,
        shot: shot.file,
        existing: fields.map((f) => f.value),
      };
    }
    const answers = args.answers.map((x) => String(x ?? "").trim());
    let filled = 0;
    let afterFields = fields;
    if (!args.dryRun) {
      filled = await fillAndSaveBlankAnswers(args, blankFrame, answers);
      afterFields = await readBlankFields(blankFrame);
    }
    return {
      ok: true,
      answers,
      reason: "manual：使用 --answers 人工答案覆盖，未请求模型",
      filled,
      blankCount,
      shot: shot.file,
      existing: fields.map((f) => f.value),
      actualChecked: afterFields.map((f) => f.value),
    };
  }

  const solved = await solveFillBlank(args, {
    title: `${label} ${problem.header}`,
    blankCount,
    imageBase64: shot.imageBase64,
  });
  if (!solved.ok) {
    return { ok: false, error: solved.error || "模型未返回填空答案", raw: solved.raw, shot: shot.file };
  }

  let filled = 0;
  let afterFields = fields;
  if (!args.dryRun) {
    filled = await fillAndSaveBlankAnswers(args, blankFrame, solved.answers);
    afterFields = await readBlankFields(blankFrame);
  }
  return {
    ok: true,
    answers: solved.answers,
    reason: solved.reason,
    filled,
    blankCount,
    shot: shot.file,
    existing: fields.map((f) => f.value),
    actualChecked: afterFields.map((f) => f.value),
  };
}

async function clickVisibleButtonByText(scope, patterns, { timeout = 5000 } = {}) {
  const result = await scope
    .evaluate((sources) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 1 && r.height > 1 && st.display !== "none" && st.visibility !== "hidden";
      };
      const pats = sources.map((s) => new RegExp(s));
      const nodes = [...document.querySelectorAll("button,a,.btn,.big_bottom_btn,.el-button,[role=button]")];
      for (const el of nodes) {
        const text = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        if (!visible(el) || !text) continue;
        if (pats.some((re) => re.test(text))) {
          el.click();
          return { ok: true, text };
        }
      }
      return { ok: false, text: "" };
    }, patterns.map((p) => p.source))
    .catch(() => ({ ok: false, text: "" }));
  if (result.ok) {
    await sleep(timeout);
    return result;
  }
  return result;
}

async function confirmQuizDialogs(page, frame) {
  const scopes = [frame, page.mainFrame()];
  const actions = [];
  for (let i = 0; i < 4; i += 1) {
    let clicked = false;
    for (const scope of scopes) {
      const res = await clickVisibleButtonByText(scope, [/^(确定|确认|提交|交卷|是|好的)$/], { timeout: 1200 });
      if (res.ok) {
        actions.push(res.text);
        clicked = true;
        break;
      }
    }
    if (!clicked) break;
  }
  return actions;
}

async function submitQuizPaper(page, frame) {
  await page.keyboard.press("Escape").catch(() => {});
  await frame.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await sleep(800);
  let submit = { ok: false, text: "" };
  for (const css of ["#bottom_commit_btn", "#submit_quiz_btn"]) {
    const loc = frame.locator(css).first();
    if ((await loc.count().catch(() => 0)) > 0) {
      const text = await loc.innerText().catch(() => css);
      await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await loc.click({ timeout: 5000, force: true }).catch(() => {});
      submit = { ok: true, text: norm(text) || css };
      await sleep(1800);
      break;
    }
  }
  if (!submit.ok) {
    submit = await clickVisibleButtonByText(frame, [/去交卷/, /^交卷$/, /提交试卷/, /^提交$/], {
      timeout: 1800,
    });
  }
  if (!submit.ok) return { ok: false, reason: "未找到最终交卷按钮" };
  const dialogs = await confirmQuizDialogs(page, frame);
  await sleep(2500);
  const finalText = await frame
    .evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 800))
    .catch(() => "");
  return {
    ok: true,
    reason: `已点击「${submit.text}」${dialogs.length ? `，确认：${dialogs.join(" / ")}` : ""}`,
    finalText,
  };
}

export async function runQuizPapers(args, context, listPage, logger, shotDir, listUrl) {
  await gotoGradeTab(listPage, listUrl);
  const papers = await listPage.evaluate(collectQuizPapersInPage).catch((e) => {
    logger.note(`采集成绩单试卷失败：${e.message || e}`);
    return [];
  });
  logger.note(`发现试卷 ${papers.length} 份：`);
  for (const p of papers) logger.note(`  - [${p.status || "?"}] ${p.title} (${p.score || "-"})`);

  const filtered = args.only ? papers.filter((p) => p.title.includes(args.only)) : papers;
  const candidates = args.todo
    ? filtered.filter((p) => isPaperInProgress(p) || (args.startNewQuiz && isPaperNotStarted(p)))
    : args.force
      ? filtered
      : filtered.filter((p) => isPaperInProgress(p));
  const limited = args.maxHomeworks > 0 ? candidates.slice(0, args.maxHomeworks) : candidates;
  const scopeLabel = args.todo
    ? args.startNewQuiz
      ? "待做（进行中+未开始）"
      : "待做（仅进行中；未开始需允许启动）"
    : args.force
      ? "force 全部"
      : "仅进行中";
  logger.note(
    `将处理 ${limited.length} 份（${args.only ? `匹配“${args.only}”，` : ""}${scopeLabel}${args.maxHomeworks > 0 ? `，限 ${args.maxHomeworks} 份` : ""}）。\n`,
  );

  let doneCount = 0;
  let problemCount = 0;
  let submittedCount = 0;
  for (const paper of limited) {
    logger.note(`===== 试卷：${paper.title}（${paper.status || "?"}）=====`);
    await gotoGradeTab(listPage, listUrl);
    const refreshed = await listPage.evaluate(collectQuizPapersInPage).catch((e) => {
      logger.note(`  重新采集成绩单失败：${e.message || e}`);
      return [];
    });
    const target = refreshed.find((p) => p.title === paper.title) || paper;
    const opened = await openQuizPaper(listPage, target);
    if (!opened.ok) {
      logger.note("  打开试卷失败，跳过。");
      continue;
    }

    const quizPage = opened.page || listPage;
    const entered = await enterQuiz(quizPage, args, logger, paper.title);
    if (!entered.ok) {
      logger.note(`  跳过：${entered.reason}`);
      continue;
    }
    const frame = entered.frame;
    const problems = await collectQuizProblems(frame);
    if (!problems.length) {
      logger.note("  未发现可处理题块（FillBlank 或旧选择题结构）。");
      continue;
    }

    for (const problem of problems.slice(0, args.maxQuestions || problems.length)) {
      const idx = `${paper.title}#${problem.index}`;
      let rec;
      try {
        rec =
          problem.type === "fillblank"
            ? await handleFillBlankProblem(args, quizPage, frame, problem, logger, shotDir, paper.title)
            : await handleChoiceProblem(args, frame, problem, logger, shotDir, paper.title);
      } catch (e) {
        rec = { ok: false, error: e.message || String(e) };
      }
      problemCount += 1;
      logger.logQuestion({
        index: idx,
        type: rec.type || problem.type || "choice",
        stem: problem.header,
        options: rec.options || [],
        answer: rec.answers || [],
        clicked: !!(rec.ok && !args.dryRun && (rec.filled > 0 || rec.clicked)),
        skipped: !!rec.skipped,
        dryRun: args.dryRun || args.noLlm,
        inspectOnly: rec.inspectOnly,
        error: rec.ok ? undefined : rec.error,
        reason: rec.reason,
        raw: rec.raw,
        shot: rec.shot,
        answerFormat: rec.answerFormat,
        blankCount: rec.blankCount,
        actualChecked: rec.actualChecked || rec.existing,
        submitInfo:
          rec.ok && !rec.skipped && !args.dryRun && !args.noLlm
            ? rec.filled > 0
              ? `已保存 ${rec.filled}/${rec.blankCount} 空（未交卷）`
              : rec.clicked
                ? "已点选（未交卷）"
              : "未改动（未交卷）"
            : undefined,
      });
      await sleep(args.delayMs);
    }
    if (args.submit && !args.dryRun && !args.noLlm && !args.agentDump) {
      const submitResult = await submitQuizPaper(quizPage, frame);
      logger.note(
        submitResult.ok
          ? `  试卷已自动交卷：${submitResult.reason}`
          : `  自动交卷失败：${submitResult.reason}`,
      );
      if (submitResult.ok) submittedCount += 1;
    }
    doneCount += 1;
  }

  return { doneCount, planned: limited.length, problemCount, papers, submittedCount };
}
