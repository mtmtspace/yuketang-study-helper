#!/usr/bin/env node
// 刷课专用·只读 DOM 核验工具。
// 启动带登录态的 Chrome → 进入「学习内容」→ 尽量展开 → 自动/手动导出快照，
// 重点抓：顶部页签、叶子活动行(含 svg use 的 xlink:href 图标)、<video>、播放器自定义标签(xt-*)、讨论区(评论/输入/发送)。
// 纯只读：只点“学习内容/展开”帮助呈现，不刷课、不发言、不提交。导出到 output/watch-inspect/。
//
// 运行：node scripts/dump-watch.mjs                （默认打开用户那门课）
//      node scripts/dump-watch.mjs --open-url "<studentLog URL>"
// 触发再导一张：在 output/watch-inspect/ 下创建文件 GO；切换页面/打开视频/讨论也会自动导。

import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "../src/config.mjs";
import { launchBrowser } from "../src/browser.mjs";

const DEFAULT_URL =
  "https://changjiang.yuketang.cn/v2/web/studentLog/24841495?university_id=2627&platform_id=3&classroom_id=24841495&content_url=";

// —— 在页面/フレーム里执行的探查函数（必须自包含，不能引用 Node 作用域）——
function probeWatch() {
  const trim = (s, n = 160) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  };
  const cssEscape = (v) =>
    window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/[^\w-]/g, "\\$&");
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.display !== "none" && s.visibility !== "hidden";
  };
  const sel = (el) => {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return `#${cssEscape(el.id)}`;
    const cls = Array.from(el.classList || [])
      .slice(0, 3)
      .map((c) => `.${cssEscape(c)}`)
      .join("");
    return el.tagName.toLowerCase() + cls;
  };
  const path = (el) => {
    const parts = [];
    let n = el;
    let d = 0;
    while (n && n.nodeType === 1 && d < 6) {
      let p = n.tagName.toLowerCase();
      if (n.id) {
        p += `#${n.id}`;
        parts.unshift(p);
        break;
      }
      const cls = Array.from(n.classList || []).slice(0, 2).join(".");
      if (cls) p += "." + cls;
      parts.unshift(p);
      n = n.parentElement;
      d += 1;
    }
    return parts.join(" > ");
  };
  const classesOf = (el) => Array.from(el.classList || []).slice(0, 6);

  // 顶部页签（学习日志/学习内容/讨论区/公告/分组/错题集/成绩单）
  const TAB_WORDS = ["学习日志", "学习内容", "讨论区", "公告", "分组", "错题集", "成绩单"];
  const navTabs = [];
  for (const el of document.querySelectorAll("a,li,span,div,button")) {
    const t = (el.innerText || el.textContent || "").trim();
    if (TAB_WORDS.includes(t) && visible(el)) {
      navTabs.push({ text: t, selector: sel(el), path: path(el), classes: classesOf(el) });
    }
  }

  // 叶子活动：以 svg>use 图标为锚，回溯到“行”，拿 图标href + 行文本 + 行类名
  const iconRows = [];
  for (const use of document.querySelectorAll("svg use")) {
    const href = use.getAttribute("xlink:href") || use.getAttribute("href") || "";
    if (!href) continue;
    // 回溯到一个像“活动行”的祖先
    let row = use;
    for (let i = 0; i < 6 && row.parentElement; i += 1) {
      row = row.parentElement;
      const cls = Array.from(row.classList || []).join(" ");
      if (/activity|leaf|unit|list|item|row|content-box|activity-box/i.test(cls)) break;
    }
    const rowText = trim(row.innerText || row.textContent || "", 120);
    iconRows.push({
      iconHref: href,
      iconClasses: classesOf(use.closest("svg") || use),
      rowText,
      rowSelector: sel(row),
      rowClasses: classesOf(row),
      rowPath: path(row),
      visible: visible(row),
    });
  }

  // 状态词出现位置（进行中/未开始/已完成/未学/未读/已读/已结束）
  const STATUS = ["进行中", "未开始", "已完成", "未学", "未读", "已读", "已结束", "未交", "完成度"];
  const statusHits = [];
  for (const el of document.querySelectorAll("span,div,em,i,p")) {
    const t = (el.innerText || el.textContent || "").trim();
    if (t.length <= 6 && STATUS.some((w) => t === w || t.startsWith(w)) && visible(el)) {
      statusHits.push({ text: t, selector: sel(el), classes: classesOf(el) });
    }
  }

  // <video> 元素与属性
  const videos = [];
  for (const v of document.querySelectorAll("video")) {
    videos.push({
      src: trim(v.currentSrc || v.src || "", 120),
      duration: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
      currentTime: Math.round(v.currentTime || 0),
      paused: v.paused,
      muted: v.muted,
      volume: v.volume,
      playbackRate: v.playbackRate,
      readyState: v.readyState,
      path: path(v),
      selector: sel(v),
    });
  }

  // 播放器：自定义元素(含连字符的标签，如 xt-bigbutton) + 播放控制类名
  const customTags = {};
  const playerControls = [];
  const CTRL_RE = /(play|pause|speed|rate|volume|mute|sound|progress|control|bigbutton|player|seek|duration|current)/i;
  for (const el of document.querySelectorAll("*")) {
    const tag = el.tagName.toLowerCase();
    if (tag.includes("-")) customTags[tag] = (customTags[tag] || 0) + 1;
    const cls = Array.from(el.classList || []).join(" ");
    const keyt = el.getAttribute && el.getAttribute("keyt");
    if ((tag.includes("-") && /^xt-/.test(tag)) || CTRL_RE.test(cls) || keyt) {
      if (!visible(el) && !keyt) continue;
      playerControls.push({
        tag,
        selector: sel(el),
        classes: Array.from(el.classList || []).slice(0, 5),
        keyt: keyt || undefined,
        text: trim(el.innerText || el.textContent || "", 30),
        path: path(el),
      });
    }
  }

  // 讨论区：评论列表项 + 输入框 + 发送/发表按钮
  const COMMENT_RE = /(comment|discuss|reply|postil|talk|message|msg|floor|review|speak|barrage)/i;
  const commentItems = [];
  for (const el of document.querySelectorAll("li,div,article,section")) {
    const cls = Array.from(el.classList || []).join(" ");
    if (!COMMENT_RE.test(cls)) continue;
    if (!visible(el)) continue;
    const t = trim(el.innerText || el.textContent || "", 100);
    if (!t) continue;
    commentItems.push({ selector: sel(el), classes: classesOf(el), text: t, path: path(el) });
  }
  const inputs = [];
  for (const el of document.querySelectorAll(
    'textarea,[contenteditable="true"],[contenteditable=""],input[type="text"]',
  )) {
    if (!visible(el)) continue;
    inputs.push({
      tag: el.tagName.toLowerCase(),
      editable: el.getAttribute("contenteditable"),
      placeholder: trim(el.getAttribute("placeholder") || "", 60),
      selector: sel(el),
      path: path(el),
    });
  }
  const sendButtons = [];
  const SEND_RE = /(发送|发表|回复|评论|提交|确定|确认|发布)/;
  for (const el of document.querySelectorAll('button,a,span,div,[role="button"]')) {
    const t = (el.innerText || el.textContent || "").trim();
    if (t && t.length <= 8 && SEND_RE.test(t) && visible(el)) {
      sendButtons.push({ text: t, selector: sel(el), classes: classesOf(el), path: path(el) });
    }
  }

  // 类名词频（揭示设计体系）
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
    counts: {
      navTabs: navTabs.length,
      iconRows: iconRows.length,
      videos: videos.length,
      commentItems: commentItems.length,
      inputs: inputs.length,
      sendButtons: sendButtons.length,
    },
    navTabs,
    iconRows: iconRows.slice(0, 200),
    statusHits: statusHits.slice(0, 120),
    videos,
    playerControls: playerControls.slice(0, 120),
    customTags,
    discussion: { commentItems: commentItems.slice(0, 60), inputs, sendButtons },
    classTop,
  };
}

async function dumpSnapshot(page, outRoot, index, reason) {
  const dir = resolve(outRoot, `snapshot-${String(index).padStart(2, "0")}`);
  await mkdir(dir, { recursive: true });

  const url = page.url();
  const html = await page.content().catch(() => "");
  const frames = [];
  for (const frame of page.frames()) {
    try {
      const data = await frame.evaluate(probeWatch);
      frames.push({ frameUrl: frame.url(), isMain: frame === page.mainFrame(), ...data });
    } catch (e) {
      frames.push({ frameUrl: frame.url(), error: String(e.message || e) });
    }
  }

  await writeFile(resolve(dir, "url.txt"), url, "utf8");
  await writeFile(resolve(dir, "page.html"), html, "utf8");
  await writeFile(
    resolve(dir, "probe.json"),
    JSON.stringify({ url, capturedAt: new Date().toISOString(), reason, frames }, null, 2),
    "utf8",
  );
  try {
    await page.screenshot({ path: resolve(dir, "screenshot.png"), fullPage: true });
  } catch (e) {
    await writeFile(resolve(dir, "screenshot-error.txt"), String(e.message || e), "utf8");
  }

  const main = frames.find((f) => f.isMain) || frames[0] || {};
  const c = main.counts || {};
  console.log(
    `[dump #${index}] ${reason}\n  ${url}\n  页签:${c.navTabs ?? 0} 活动图标行:${c.iconRows ?? 0} ` +
      `video:${c.videos ?? 0} 评论项:${c.commentItems ?? 0} 输入框:${c.inputs ?? 0} 发送钮:${c.sendButtons ?? 0} -> ${dir}`,
  );
  return main;
}

// 尽量点“学习内容”并展开（best-effort，只为呈现，不改变完成状态），并打印诊断。
async function tryEnterContent(page) {
  // 等顶部 tab 出现，点 #tab-content（id 最稳），失败再点文本
  await page.waitForSelector("#tab-content", { timeout: 15000 }).catch(() => {});
  const tab = page.locator("#tab-content").first();
  if (await tab.count().catch(() => 0)) {
    await tab.click({ timeout: 6000 }).catch(() => {});
  } else {
    await page.getByText("学习内容", { exact: true }).first().click({ timeout: 6000 }).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 3000));
  // 展开“展开”，多点几轮（章 → 节）
  for (let round = 0; round < 4; round += 1) {
    const clicked = await page
      .evaluate(() => {
        let n = 0;
        for (const el of document.querySelectorAll("span,a,div,button,i")) {
          const t = (el.innerText || el.textContent || "").trim();
          const r = el.getBoundingClientRect();
          if (t === "展开" && r.width > 0 && r.height > 0) {
            el.click();
            n += 1;
          }
        }
        return n;
      })
      .catch(() => 0);
    if (!clicked) break;
    await new Promise((r) => setTimeout(r, 1500));
  }

  // —— 诊断：当前 tab + 各候选行选择器命中数 + 前几个“叶子样”行的文本/图标 ——
  const diag = await page
    .evaluate(() => {
      const active = (document.querySelector(".el-tabs__item.is-active")?.innerText || "?").trim();
      const cnt = (s) => document.querySelectorAll(s).length;
      const candidates = {
        "section.activity__wrap": cnt("section.activity__wrap"),
        ".activity__wrap": cnt(".activity__wrap"),
        ".leaf_list__wrap": cnt(".leaf_list__wrap"),
        ".leaf_list__wrap .activity__wrap": cnt(".leaf_list__wrap .activity__wrap"),
        ".content-box": cnt(".content-box"),
        ".activity-box": cnt(".activity-box"),
        ".leaf": cnt(".leaf"),
        "#pane-content [class*=activity]": cnt("#pane-content [class*=activity]"),
      };
      // 取 #pane-content 内、含 svg use 的“行样”元素，输出文本+图标
      const root = document.querySelector("#pane-content") || document.body;
      const samples = [];
      const seen = new Set();
      for (const use of root.querySelectorAll("svg use")) {
        let row = use;
        for (let i = 0; i < 6 && row.parentElement; i += 1) {
          row = row.parentElement;
          const c = (row.className || "").toString();
          if (/activity__wrap|leaf|content-box/i.test(c)) break;
        }
        if (seen.has(row)) continue;
        seen.add(row);
        const hrefs = [...row.querySelectorAll("svg use")].map(
          (u) => u.getAttribute("xlink:href") || u.getAttribute("href") || "",
        );
        const text = (row.innerText || row.textContent || "").replace(/\s+/g, " ").trim().slice(0, 70);
        const cls = (row.className || "").toString().slice(0, 60);
        if (text) samples.push({ cls, hrefs: hrefs.join(","), text });
        if (samples.length >= 12) break;
      }
      return { active, candidates, samples };
    })
    .catch((e) => ({ error: String(e.message || e) }));

  console.log(`\n  [诊断] 当前激活 tab = ${diag.active}`);
  console.log("  [诊断] 行选择器命中数：", JSON.stringify(diag.candidates));
  console.log("  [诊断] #pane-content 内叶子样行（文本 | 图标 | class）：");
  for (const s of diag.samples || []) console.log(`     · ${s.text}  |  ${s.hrefs}  |  ${s.cls}`);
  console.log("");
}


async function main() {
  const args = parseArgs();
  const url = args.openUrl || DEFAULT_URL;
  const outRoot = resolve(args.outDirAbs, "watch-inspect");
  await mkdir(outRoot, { recursive: true });
  const goFile = resolve(outRoot, "GO");
  if (existsSync(goFile)) await rm(goFile).catch(() => {});

  console.log("启动带登录态的 Chrome（独立配置档）……");
  const { context, page } = await launchBrowser(args);

  console.log(`打开课程页：${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => {
    console.log("  打开失败/超时（可手动在窗口里打开该课程）：" + e.message);
  });
  await new Promise((r) => setTimeout(r, 3500));

  console.log(
    [
      "",
      "==== 只读核验 · 操作提示 ====",
      "1) 若是登录页，请在弹出的 Chrome 里登录（扫码/账号皆可）。登录后回这里等它自动抓。",
      "2) 脚本会尝试自动进入「学习内容」并展开目录，并自动抓第一张快照。",
      "3) 接着请你在窗口里：① 点开一个【视频】活动，让它出现播放器（自动抓）；",
      "   ② 返回，点开一个【讨论】活动（自动抓）。每次页面变化都会自动导出一张。",
      `   手动再抓一张：创建文件 ${goFile}`,
      "导出目录：" + outRoot,
      "（保持本进程运行；完成后告诉 Claude 停止它。）",
      "=============================",
      "",
    ].join("\n"),
  );

  await tryEnterContent(page).catch(() => {});

  let index = 0;
  let lastKey = "";

  // 先抓一张初始（学习内容/展开后）
  index += 1;
  await dumpSnapshot(page, outRoot, index, "初始(学习内容/展开后)").catch((e) =>
    console.log("初始 dump 失败：" + e.message),
  );

  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));

    const pages = context.pages().filter((p) => (p.url() || "").includes(args.urlContains));
    const cur = pages[pages.length - 1];
    if (!cur) continue;

    // 手动触发
    if (existsSync(goFile)) {
      await rm(goFile).catch(() => {});
      index += 1;
      await dumpSnapshot(cur, outRoot, index, "手动触发(GO)").catch(() => {});
      continue;
    }

    // 变化检测：url + video数 + 是否有评论框
    try {
      const sig = await cur.evaluate(() => {
        const has = (s) => !!document.querySelector(s);
        return [
          location.href,
          document.querySelectorAll("video").length,
          document.querySelectorAll("svg use").length,
          has('textarea,[contenteditable="true"]') ? "in" : "",
        ].join("|");
      });
      if (sig !== lastKey) {
        lastKey = sig;
        index += 1;
        await dumpSnapshot(cur, outRoot, index, "检测到页面变化").catch(() => {});
      }
    } catch {
      /* 页面可能在导航，忽略 */
    }
  }
}

main().catch((e) => {
  console.error("dump-watch 失败:", e.message);
  process.exitCode = 1;
});
