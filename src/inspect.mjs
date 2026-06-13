// DOM 导出工具：启动带登录态的 Chrome，等你登录并打开作业题目页，
// 自动检测“含题目的页面”并落盘结构快照（HTML / 结构化候选 / 截图），供设计选择器用。
// 不点选、不提交，纯只读导出。
//
// 运行（后台）：node src/inspect.mjs
// 触发再次导出：在 output/inspect/ 下创建文件 GO（或导航到新页面会自动再导一张）。

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "./config.mjs";
import { launchBrowser } from "./browser.mjs";

// —— 在浏览器页面里执行的探查函数（必须自包含，不能引用 Node 作用域）——
function inspectFrame() {
  const trim = (s, n = 200) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  };
  const cssEscape = (v) =>
    window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/[^\w-]/g, "\\$&");
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const shortSelector = (el) => {
    if (el.id) return `#${cssEscape(el.id)}`;
    const cls = Array.from(el.classList || [])
      .slice(0, 3)
      .map((c) => `.${cssEscape(c)}`)
      .join("");
    return el.tagName.toLowerCase() + cls;
  };
  const domPath = (el) => {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += `#${node.id}`;
        parts.unshift(part);
        break;
      }
      const cls = Array.from(node.classList || []).slice(0, 2).join(".");
      if (cls) part += "." + cls;
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(
          (c) => c.tagName === node.tagName,
        );
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(" > ");
  };
  const labelTextFor = (input) => {
    let text = "";
    if (input.id) {
      const lab = document.querySelector(`label[for="${input.id}"]`);
      if (lab) text = lab.innerText || lab.textContent || "";
    }
    if (!text) {
      const wrapLab = input.closest("label");
      if (wrapLab) text = wrapLab.innerText || wrapLab.textContent || "";
    }
    if (!text && input.parentElement) {
      text = input.parentElement.innerText || input.parentElement.textContent || "";
    }
    return trim(text, 160);
  };

  // 类名词频（揭示设计体系）
  const classCounts = {};
  for (const el of document.querySelectorAll("*")) {
    for (const c of el.classList || []) classCounts[c] = (classCounts[c] || 0) + 1;
  }
  const classTokensTop = Object.entries(classCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60)
    .map(([name, count]) => ({ name, count }));

  // 输入控件（radio/checkbox 及 role 形式）
  const inputs = [];
  const controlSel =
    'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]';
  for (const el of document.querySelectorAll(controlSel)) {
    inputs.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || el.getAttribute("role"),
      name: el.getAttribute("name") || "",
      value: trim(el.getAttribute("value") || "", 60),
      id: el.id || "",
      checked: el.checked || el.getAttribute("aria-checked") === "true",
      visible: isVisible(el),
      labelText: labelTextFor(el),
      selector: shortSelector(el),
      path: domPath(el),
    });
  }

  // 选项样式容器（类名含 option/choice/answer/radio/checkbox/item）
  const optionLike = [];
  const optRe = /(option|choice|answer|radio|checkbox|^item$|select)/i;
  for (const el of document.querySelectorAll("*")) {
    const cls = Array.from(el.classList || []);
    if (!cls.some((c) => optRe.test(c))) continue;
    if (!isVisible(el)) continue;
    const text = trim(el.innerText || el.textContent || "", 120);
    if (!text) continue;
    optionLike.push({
      selector: shortSelector(el),
      classes: cls.slice(0, 5),
      text,
      hasControl: !!el.querySelector(controlSel),
      path: domPath(el),
    });
  }

  // 可点击按钮（找“下一题/上一题/提交/交卷/保存/确定”）
  const buttons = [];
  for (const el of document.querySelectorAll(
    'button, a, [role="button"], input[type="button"], input[type="submit"]',
  )) {
    if (!isVisible(el)) continue;
    const text = trim(el.innerText || el.textContent || el.value || "", 40);
    if (!text) continue;
    buttons.push({
      tag: el.tagName.toLowerCase(),
      text,
      selector: shortSelector(el),
      classes: Array.from(el.classList || []).slice(0, 4),
      disabled: el.disabled || el.getAttribute("aria-disabled") === "true",
    });
  }

  // 题型提示
  const bodyText = document.body ? document.body.innerText : "";
  const typeHints = (bodyText.match(/(单选题|多选题|判断题|填空题|简答题|问答题|不定项)/g) || [])
    .slice(0, 30);

  return {
    title: document.title,
    typeHints,
    counts: {
      radios: document.querySelectorAll('input[type="radio"],[role="radio"]').length,
      checkboxes: document.querySelectorAll('input[type="checkbox"],[role="checkbox"]').length,
    },
    inputs: inputs.slice(0, 120),
    optionLike: optionLike.slice(0, 120),
    buttons: buttons.slice(0, 80),
    classTokensTop,
  };
}

function looksLikeQuestion(frameData) {
  const radios = frameData.counts.radios + frameData.counts.checkboxes;
  return radios >= 2 || frameData.typeHints.length > 0;
}

async function dumpSnapshot(page, outRoot, index, reason) {
  const dir = resolve(outRoot, `snapshot-${String(index).padStart(2, "0")}`);
  await mkdir(dir, { recursive: true });

  const url = page.url();
  const html = await page.content();
  const visibleText = await page.evaluate(() => (document.body ? document.body.innerText : ""));

  // 每个 frame 跑一次探查
  const frames = [];
  for (const frame of page.frames()) {
    try {
      const data = await frame.evaluate(inspectFrame);
      frames.push({ frameUrl: frame.url(), isMain: frame === page.mainFrame(), ...data });
    } catch (e) {
      frames.push({ frameUrl: frame.url(), error: String(e.message || e) });
    }
  }

  await writeFile(resolve(dir, "url.txt"), url, "utf8");
  await writeFile(resolve(dir, "page.html"), html, "utf8");
  await writeFile(resolve(dir, "visible-text.txt"), visibleText, "utf8");
  await writeFile(
    resolve(dir, "candidates.json"),
    JSON.stringify({ url, capturedAt: new Date().toISOString(), reason, frames }, null, 2),
    "utf8",
  );
  try {
    await page.screenshot({ path: resolve(dir, "screenshot.png"), fullPage: true });
  } catch (e) {
    await writeFile(resolve(dir, "screenshot-error.txt"), String(e.message || e), "utf8");
  }

  const qframes = frames.filter(looksLikeQuestion);
  console.log(
    `[dump #${index}] ${reason} | ${url}\n` +
      `  题型提示: ${frames.flatMap((f) => f.typeHints || []).join(",") || "(无)"} | ` +
      `radio/checkbox 帧: ${qframes.length} | -> ${dir}`,
  );
}

async function main() {
  const args = parseArgs();
  const outRoot = resolve(args.outDirAbs, "inspect");
  await mkdir(outRoot, { recursive: true });
  const goFile = resolve(outRoot, "GO");
  if (existsSync(goFile)) await rm(goFile);

  console.log("启动带登录态的 Chrome（独立配置档）……");
  const { context } = await launchBrowser(args);

  console.log(
    [
      "",
      "==== 请在弹出的 Chrome 窗口里操作 ====",
      "1) 登录雨课堂（如未登录）。",
      "2) 打开一份作业/练习，进入【有题目和选项】的页面。",
      "",
      "脚本会自动检测含题目的页面并导出结构快照；切换题目/翻页会再导一张。",
      `也可手动触发：创建文件 ${goFile}`,
      "导出目录：" + outRoot,
      "（保持本进程运行；完成后由 Claude 停止它。）",
      "====================================",
      "",
    ].join("\n"),
  );

  let index = 0;
  let lastKey = "";
  const seenQuestionUrls = new Set();

  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));

    // 找当前命中雨课堂的页面（取最后一个活动的）
    const pages = context.pages().filter((p) => (p.url() || "").includes(args.urlContains));
    const page = pages[pages.length - 1];

    // 手动触发
    if (existsSync(goFile)) {
      await rm(goFile).catch(() => {});
      if (page) {
        index += 1;
        await dumpSnapshot(page, outRoot, index, "手动触发(GO)");
      } else {
        console.log("[GO] 当前没有雨课堂标签页。");
      }
      continue;
    }

    if (!page) continue;

    let frameQuestion = false;
    try {
      const quick = await page.evaluate(() => ({
        r: document.querySelectorAll('input[type="radio"],[role="radio"]').length,
        c: document.querySelectorAll('input[type="checkbox"],[role="checkbox"]').length,
        hint: /(单选题|多选题|判断题)/.test(document.body ? document.body.innerText : ""),
        url: location.href,
      }));
      frameQuestion = quick.r + quick.c >= 2 || quick.hint;
      const key = quick.url + "|" + quick.r + "|" + quick.c;
      if (frameQuestion && key !== lastKey && !seenQuestionUrls.has(key)) {
        lastKey = key;
        seenQuestionUrls.add(key);
        index += 1;
        await dumpSnapshot(page, outRoot, index, "自动检测到题目页/内容变化");
      }
    } catch {
      /* 页面可能正在导航，忽略 */
    }
  }
}

main().catch((e) => {
  console.error("inspect 失败:", e.message);
  process.exitCode = 1;
});
