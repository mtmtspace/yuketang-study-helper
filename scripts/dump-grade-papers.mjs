#!/usr/bin/env node
// 只读结构探针：打开 studentLog 页 -> 进入「成绩单」-> 导出带“试卷”标签的卡片/行结构。
// 不点击作业、不选择答案、不提交；只点顶部 tab 以呈现页面。
//
// 用法：
//   node scripts/dump-grade-papers.mjs --open-url "<studentLog URL>"
//   node scripts/dump-grade-papers.mjs --open-url "<studentLog URL>" --headless

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "../src/config.mjs";
import { launchBrowser, closeBrowser } from "../src/browser.mjs";
import { dismissPopups, sleep } from "../src/answer-loop.mjs";

const DEFAULT_URL =
  "https://www.yuketang.cn/v2/web/studentLog/30654800?university_id=0&platform_id=3&classroom_id=30654800&content_url=";

function printHelp() {
  console.log(`
只读导出 studentLog「成绩单」里的试卷结构。

用法:
  node scripts/dump-grade-papers.mjs --open-url "<studentLog URL>"

选项:
  --headless            无界面运行
  --exit-when-done      导出后关闭浏览器
  --out <dir>           输出目录（默认 output）
  -h, --help            显示帮助

说明:
  - 只点击「成绩单」tab 以呈现结构。
  - 不打开试卷、不选择答案、不提交。
`);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function probeGradePaperPage() {
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const short = (s, n = 180) => {
    const t = norm(s);
    return t.length > n ? `${t.slice(0, n - 1)}...` : t;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && st.display !== "none" && st.visibility !== "hidden";
  };
  const cssEscape = (v) =>
    window.CSS && CSS.escape ? CSS.escape(String(v)) : String(v).replace(/[^\w-]/g, "\\$&");
  const selectorOf = (el) => {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return `#${cssEscape(el.id)}`;
    const cls = Array.from(el.classList || [])
      .filter(Boolean)
      .slice(0, 4)
      .map((c) => `.${cssEscape(c)}`)
      .join("");
    const role = el.getAttribute("role");
    const dataId =
      el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-cy");
    if (dataId) return `[data-testid="${dataId}"]`;
    if (role) return `${el.tagName.toLowerCase()}[role="${role}"]${cls}`;
    return `${el.tagName.toLowerCase()}${cls}`;
  };
  const pathOf = (el) => {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 7) {
      parts.unshift(selectorOf(node));
      if (node.id) break;
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(" > ");
  };
  const classesOf = (el) => Array.from(el.classList || []).slice(0, 8);

  const tabWords = ["学习日志", "学习内容", "成绩单", "讨论区", "公告", "分组", "错题集"];
  const navTabs = [];
  for (const el of document.querySelectorAll("a,button,li,div,span,[role=tab]")) {
    const text = norm(el.innerText || el.textContent);
    if (tabWords.includes(text) && visible(el)) {
      navTabs.push({
        text,
        selector: selectorOf(el),
        classes: classesOf(el),
        path: pathOf(el),
      });
    }
  }

  const tagHits = [];
  for (const el of document.querySelectorAll("span,em,i,b,div,p")) {
    const text = norm(el.innerText || el.textContent);
    if (text === "试卷" || text === "作业" || text === "考试") {
      tagHits.push({
        text,
        selector: selectorOf(el),
        classes: classesOf(el),
        path: pathOf(el),
        visible: visible(el),
      });
    }
  }

  const rowLikeSelectors = [
    "tr",
    "li",
    "section",
    "article",
    ".el-card",
    ".el-table__row",
    "[class*=card]",
    "[class*=item]",
    "[class*=homework]",
    "[class*=paper]",
    "[class*=exam]",
    "[class*=work]",
  ];
  const seen = new Set();
  const paperRows = [];
  const maybeRows = [];

  const collectRow = (row, reason) => {
    if (!row || seen.has(row)) return;
    seen.add(row);
    const text = short(row.innerText || row.textContent, 320);
    if (!text) return;
    const links = [...row.querySelectorAll("a[href]")]
      .slice(0, 8)
      .map((a) => ({ text: short(a.innerText || a.textContent, 80), href: a.href }));
    const buttons = [...row.querySelectorAll("button,a,[role=button],.el-button")]
      .filter(visible)
      .slice(0, 12)
      .map((b) => ({
        text: short(b.innerText || b.textContent, 80),
        selector: selectorOf(b),
        classes: classesOf(b),
      }));
    const labels = [...row.querySelectorAll("span,em,i,b")]
      .map((x) => short(x.innerText || x.textContent, 24))
      .filter((x) => x && x.length <= 16)
      .slice(0, 20);
    const entry = {
      reason,
      text,
      selector: selectorOf(row),
      classes: classesOf(row),
      path: pathOf(row),
      childCount: row.children.length,
      links,
      buttons,
      labels,
    };
    if (text.includes("试卷")) paperRows.push(entry);
    else if (/作业|考试|测验|未开始|已完成|进行中|已截止|\d+\s*\/\s*\d+/.test(text)) maybeRows.push(entry);
  };

  for (const el of document.querySelectorAll("span,em,i,b,div,p")) {
    const text = norm(el.innerText || el.textContent);
    if (text !== "试卷") continue;
    let row = el;
    for (let i = 0; i < 8 && row.parentElement; i += 1) {
      row = row.parentElement;
      const rowText = norm(row.innerText || row.textContent);
      const cls = String(row.className || "");
      if (
        rowText.length >= 8 &&
        rowText.length <= 500 &&
        (/card|item|row|paper|exam|homework|work|task|el-table/i.test(cls) || row.children.length >= 2)
      ) {
        collectRow(row, "ancestor-of-tag");
        break;
      }
    }
  }

  for (const css of rowLikeSelectors) {
    for (const row of document.querySelectorAll(css)) {
      const text = norm(row.innerText || row.textContent);
      if (!text || text.length > 500) continue;
      if (text.includes("试卷")) collectRow(row, css);
      else if (/作业|考试|测验/.test(text) && /(未开始|已完成|进行中|已截止|\d+\s*\/\s*\d+)/.test(text)) {
        collectRow(row, css);
      }
    }
  }

  const interactives = [];
  for (const el of document.querySelectorAll("button,a,[role=button],input,textarea,[contenteditable=true]")) {
    if (!visible(el)) continue;
    const text = short(el.innerText || el.textContent || el.getAttribute("placeholder") || "", 120);
    const href = el.href || el.getAttribute("href") || "";
    if (!text && !href) continue;
    interactives.push({
      tag: el.tagName.toLowerCase(),
      text,
      href,
      selector: selectorOf(el),
      classes: classesOf(el),
      path: pathOf(el),
    });
    if (interactives.length >= 160) break;
  }

  const classCounts = {};
  for (const el of document.querySelectorAll("*")) {
    for (const c of el.classList || []) classCounts[c] = (classCounts[c] || 0) + 1;
  }
  const classTop = Object.entries(classCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 80)
    .map(([name, count]) => ({ name, count }));

  return {
    url: location.href,
    title: document.title,
    bodyText: short(document.body ? document.body.innerText : "", 4000),
    counts: {
      navTabs: navTabs.length,
      tagHits: tagHits.length,
      paperRows: paperRows.length,
      maybeRows: maybeRows.length,
      interactives: interactives.length,
    },
    navTabs,
    tagHits: tagHits.slice(0, 80),
    paperRows: paperRows.slice(0, 120),
    maybeRows: maybeRows.slice(0, 80),
    interactives,
    classTop,
  };
}

async function clickTab(page, text) {
  await page.waitForSelector("body", { timeout: 20000 }).catch(() => {});
  const loc = page.getByText(text, { exact: true }).first();
  if (await loc.isVisible({ timeout: 5000 }).catch(() => false)) {
    await loc.click({ timeout: 8000 }).catch(() => {});
    return true;
  }
  const clicked = await page
    .evaluate((tabText) => {
      for (const el of document.querySelectorAll("a,button,li,div,span,[role=tab]")) {
        const text = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        const r = el.getBoundingClientRect();
        if (text === tabText && r.width > 1 && r.height > 1) {
          el.click();
          return true;
        }
      }
      return false;
    }, text)
    .catch(() => false);
  return clicked;
}

async function dumpSurface(page, outDir, reason) {
  const frames = [];
  for (const frame of page.frames()) {
    try {
      frames.push({ frameUrl: frame.url(), isMain: frame === page.mainFrame(), ...(await frame.evaluate(probeGradePaperPage)) });
    } catch (e) {
      frames.push({ frameUrl: frame.url(), error: String(e.message || e) });
    }
  }
  const html = await page.content().catch(() => "");
  const data = {
    capturedAt: new Date().toISOString(),
    reason,
    pageUrl: page.url(),
    frames,
  };
  await writeFile(resolve(outDir, "grade-papers.json"), JSON.stringify(data, null, 2), "utf8");
  await writeFile(resolve(outDir, "page.html"), html, "utf8").catch(() => {});
  const main = frames.find((f) => f.isMain) || frames[0] || {};
  await writeFile(resolve(outDir, "visible-text.txt"), main.bodyText || "", "utf8").catch(() => {});
  await page.screenshot({ path: resolve(outDir, "screenshot.png"), fullPage: true }).catch(async (e) => {
    await writeFile(resolve(outDir, "screenshot-error.txt"), String(e.message || e), "utf8");
  });
  return data;
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    return;
  }
  const url = args.openUrl || DEFAULT_URL;
  const outDir = resolve(args.outDirAbs, "grade-papers", stamp());
  await mkdir(outDir, { recursive: true });

  console.log(`打开页面：${url}`);
  const { context, page } = await launchBrowser(args);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => {
    console.log(`  打开失败/超时：${e.message}`);
  });
  await sleep(3000);
  await dismissPopups(page).catch(() => {});
  const clicked = await clickTab(page, "成绩单");
  await sleep(clicked ? 4500 : 2500);
  await dismissPopups(page).catch(() => {});

  const data = await dumpSurface(page, outDir, clicked ? "成绩单 tab" : "未点击到成绩单 tab");
  const main = data.frames.find((f) => f.isMain) || data.frames[0] || {};
  console.log(
    `导出完成：${outDir}\n` +
      `  URL: ${page.url()}\n` +
      `  tabs=${main.counts?.navTabs ?? 0}, tagHits=${main.counts?.tagHits ?? 0}, ` +
      `paperRows=${main.counts?.paperRows ?? 0}, maybeRows=${main.counts?.maybeRows ?? 0}`,
  );

  if (args.exitWhenDone || args.headless) await closeBrowser(context);
  else console.log("浏览器保持打开；确认后可手动关闭，或 Ctrl+C 结束。");
}

main().catch((e) => {
  console.error("dump-grade-papers 失败:", e.message || e);
  process.exitCode = 1;
});
