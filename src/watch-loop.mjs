// 自动刷课核心编排。被 src/watch.mjs（命令行）和 src/cli.mjs（交互菜单）调用。
// 选择器集中在 src/selectors.mjs（已据 output/watch-inspect 现场核验）。
//
// 结构要点（核验所得）：
//  · 「学习内容」列表在一个 iframe 内（URL 含 studycontent）。叶子单元 = .leaf-detail。
//  · 点叶子 = 顶层整页跳转到详情页：视频 …/xcloud/video-student/…，讨论 …/lms/<cls>/forum/…（详情页在顶层主文档）。
//  · 看完后顶层 goBack 回 studentLog，重新进入 iframe 再枚举。
//
// 相对油猴脚本的根本改进：不靠整页 reload 盲目前进，而是「枚举 iframe 叶子 → 选下一个未完成 → 顶层打开 → 处理 → 返回 → 再枚举」
// 的受控循环，确定性切到下一个，彻底解决「切不到下一个视频」。

import { sleep, dismissPopups } from "./answer-loop.mjs";
import { SEL } from "./selectors.mjs";

// ===================== 在页面/iframe 里执行的自包含函数（接收 sel；不传 RegExp）=====================

// iframe 内：点全局「展开」，尽量让所有叶子可见。返回点击数。
function expandLeavesInPage(sel) {
  let n = 0;
  for (const el of document.querySelectorAll("span,a,div,button,i")) {
    const t = (el.innerText || el.textContent || "").trim();
    if (sel.leaf.expandText.includes(t) && el.getBoundingClientRect().height > 0) {
      el.click();
      n += 1;
    }
  }
  return n;
}

// iframe 内：枚举叶子单元，给每个打 data-watch-idx，返回 [{idx,title,status,hint}]。
function collectUnitsInPage(sel) {
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const rows = [...document.querySelectorAll(sel.leaf.row)];
  const units = [];
  let idx = 0;
  for (const row of rows) {
    const titleEl = row.querySelector(sel.leaf.title);
    const title = norm(titleEl ? titleEl.innerText : row.innerText).slice(0, 80);
    if (!title) continue;

    const hasIcon = (arr) => arr.some((kw) => row.querySelector(`[class*="${kw}"]`));
    let hint = "read";
    if (hasIcon(sel.leaf.icon.video)) hint = "video";
    else if (hasIcon(sel.leaf.icon.discuss)) hint = "discuss";
    else if (hasIcon(sel.leaf.icon.exercise)) hint = "exercise";
    else if (hasIcon(sel.leaf.icon.read)) hint = "read";

    const t = norm(row.innerText);
    let done = sel.statusDoneText.some((w) => t.includes(w));
    const pm = t.match(/(\d+(?:\.\d+)?)\s*%/);
    if (pm && parseFloat(pm[1]) >= 95) done = true;

    row.setAttribute("data-watch-idx", String(idx));
    units.push({ idx, title, status: done ? "done" : "todo", hint });
    idx += 1;
  }
  return units;
}

// 详情页（顶层）：对所有 <video>/<audio> 强制倍速+静音并播放。
// 关键：注入一次性持续监听器——播放器一旦把 muted/playbackRate 改回，监听器立刻改正（毫秒级），
// 解决「3 秒轮询空档漏音」「UI 把倍速重置」。返回是否存在 video。
function hasVideoInPage() {
  return !!document.querySelector("video");
}

function setupVideoInPage(arg) {
  const media = [...document.querySelectorAll("video, audio")];
  if (!media.length) return false;
  const hasVideo = media.some((m) => m.tagName === "VIDEO");
  for (const v of media) {
    const enforce = () => {
      try {
        if (arg.mute) {
          if (!v.muted) v.muted = true;
          if (v.volume !== 0) v.volume = 0;
        }
      } catch {
        /* */
      }
      try {
        if (Math.abs((v.playbackRate || 1) - arg.speed) > 0.01) v.playbackRate = arg.speed;
      } catch {
        /* */
      }
    };
    if (!v.__watchHooked) {
      v.__watchHooked = true;
      try {
        v.defaultPlaybackRate = arg.speed;
      } catch {
        /* */
      }
      try {
        v.defaultMuted = !!arg.mute;
      } catch {
        /* */
      }
      for (const ev of [
        "ratechange",
        "volumechange",
        "play",
        "playing",
        "loadedmetadata",
        "loadeddata",
        "canplay",
        "timeupdate",
        "progress",
        "seeked",
      ]) {
        try {
          v.addEventListener(ev, enforce);
        } catch {
          /* */
        }
      }
    }
    enforce();
    try {
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    } catch {
      /* */
    }
  }
  return hasVideo;
}

// 详情页：点播放器自身的「音量键/倍速菜单」，让静音作用到播放器（彻底消除漏音）、倍速 UI 显示目标值。
// 幂等：已静音 / 已是目标速度则不重复点。arg = { speed, mute, ui }。
function applyPlayerUiInPage(arg) {
  const res = {};
  const ui = arg.ui;

  const point = (el) => {
    const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (!r || !Number.isFinite(r.left)) return { x: 10, y: 10 };
    return {
      x: r.width > 0 ? r.left + r.width / 2 : 10,
      y: r.height > 0 ? r.top + r.height / 2 : 10,
    };
  };
  const fire = (el, type, xy = point(el)) => {
    if (!el) return;
    el.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: xy.x,
        clientY: xy.y,
      }),
    );
  };
  const revealControls = (hotspot) => {
    const root = document.querySelector(ui.root) || document.body;
    if (root) {
      const r = root.getBoundingClientRect();
      const xy = {
        x: r.width > 0 ? r.left + r.width / 2 : 10,
        y: r.height > 0 ? r.top + Math.max(1, r.height - 8) : 10,
      };
      for (const t of ["mouseenter", "mouseover", "mousemove"]) fire(root, t, xy);
    }
    if (hotspot) for (const t of ["mouseenter", "mouseover", "mousemove"]) fire(hotspot, t);
  };
  const press = (el, hotspot = el) => {
    if (!el) return false;
    revealControls(hotspot);
    try {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch {
      /* */
    }
    fire(el, "mousemove");
    fire(el, "mousedown");
    fire(el, "mouseup");
    try {
      el.click();
    } catch {
      fire(el, "click");
    }
    return true;
  };
  const cssEscape = (s) =>
    window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, "\\$&");
  const rateKeys = (() => {
    const n = Number(arg.speed);
    return [...new Set([n.toFixed(2), n.toFixed(1), String(n)])];
  })();
  const rateFromText = (s) => {
    const m = String(s || "").match(/(\d+(?:\.\d+)?)\s*[xX×倍]?/);
    return m ? parseFloat(m[1]) : NaN;
  };
  const forceMedia = () => {
    for (const v of document.querySelectorAll("video, audio")) {
      try {
        if (arg.mute) {
          v.muted = true;
          v.volume = 0;
        }
      } catch {
        /* */
      }
      try {
        if (Math.abs((v.playbackRate || 1) - arg.speed) > 0.01) v.playbackRate = arg.speed;
      } catch {
        /* */
      }
    }
  };

  // 倍速：优先按播放器真实菜单项 keyt="2.00" 点击，兜底再按文本 2.00X 匹配。
  const speedBtn = document.querySelector(ui.speedBtn);
  if (speedBtn) {
    const lab = (document.querySelector(ui.speedValue)?.innerText || "").trim();
    res.speedLabel = lab;
    const cur = rateFromText(lab || "1");
    if (Math.abs(cur - arg.speed) > 0.01) {
      revealControls(speedBtn);
      const scope = speedBtn.closest(ui.speedScope) || speedBtn;
      const scopes = [scope, document];
      let target = null;
      for (const where of scopes) {
        for (const key of rateKeys) {
          target = where.querySelector(`[keyt="${cssEscape(key)}"]`);
          if (target) break;
        }
        if (target) break;
      }
      if (!target) {
        for (const where of scopes) {
          for (const li of where.querySelectorAll(ui.speedItem)) {
            // 菜单隐藏时 innerText 为空，必须用 textContent
            const n = rateFromText((li.textContent || li.innerText || "").trim());
            if (Number.isFinite(n) && Math.abs(n - arg.speed) < 0.01) {
              target = li;
              break;
            }
          }
          if (target) break;
        }
      }
      if (target) {
        press(target, speedBtn);
        res.speedSet = true;
        res.speedKey = target.getAttribute("keyt") || "";
        res.speedAfter = (document.querySelector(ui.speedValue)?.innerText || "").trim();
      }
    }
  }
  // 静音：按旧油猴脚本的方式点 xt-volumebutton > xt-icon；只 claim 一次，之后用 media 属性兜底。
  if (arg.mute) {
    const volBtn = document.querySelector(ui.volumeBtn);
    if (volBtn) {
      const txt = (volBtn.innerText || "").replace(/\s/g, "");
      res.volText = txt;
      const mutedUi = /^0%/.test(txt) || /mute|jingyin|silent/i.test(String(volBtn.className || ""));
      if (!mutedUi && volBtn.getAttribute("data-watch-mute-claimed") !== "1") {
        const icon = volBtn.querySelector(ui.volumeIcon) || document.querySelector(ui.volumeIcon) || volBtn;
        if (press(icon, volBtn)) {
          volBtn.setAttribute("data-watch-mute-claimed", "1");
          res.muteSet = true;
          res.volAfter = (volBtn.innerText || "").replace(/\s/g, "");
        }
      } else {
        res.volAfter = txt;
      }
    }
  }
  forceMedia();
  if (speedBtn) res.speedAfter = (document.querySelector(ui.speedValue)?.innerText || "").trim();
  if (arg.mute) {
    const volBtn = document.querySelector(ui.volumeBtn);
    if (volBtn) res.volAfter = (volBtn.innerText || "").replace(/\s/g, "");
  }
  const media = [...document.querySelectorAll("video, audio")];
  if (media.length) {
    res.media = media.map((v) => {
      let volume = null;
      let rate = null;
      try {
        volume = v.volume;
      } catch {
        /* */
      }
      try {
        rate = v.playbackRate;
      } catch {
        /* */
      }
      return { muted: !!v.muted, volume, rate };
    });
  }
  return res;
}

// 详情页：每轮“看视频”动作——读完成度 + 强制 2x/静音 + 管理播放/末尾收尾。
// arg = { speed, mute, doneThreshold, progressSel }。返回状态对象。
function keepWatchingInPage(arg) {
  const vids = [...document.querySelectorAll("video")];
  const v = vids.find((x) => (x.duration || 0) > 0) || vids[0];
  let percent = null;
  const scan = (s) => {
    const m = String(s || "").match(/完成度[:：]?\s*(\d+(?:\.\d+)?)\s*%/);
    if (m) percent = parseFloat(m[1]);
  };
  for (const css of arg.progressSel) for (const el of document.querySelectorAll(css)) scan(el.innerText);
  if (percent == null) scan(document.body ? document.body.innerText : "");
  if (!v) return { hasVideo: false, percent };

  const dur = v.duration || 0;
  const atEnd = dur > 0 && v.currentTime >= dur - 1.0;
  try {
    if (arg.mute) {
      v.muted = true;
      v.volume = 0;
    }
  } catch {
    /* */
  }
  try {
    if (Math.abs((v.playbackRate || 1) - arg.speed) > 0.01) v.playbackRate = arg.speed;
  } catch {
    /* */
  }

  // 未结束就保持播放；已结束就让它停在末尾等服务端结算——绝不 seek/重播（回退会打乱“已观看区间”统计）。
  if (!atEnd) {
    try {
      if (v.paused && !v.ended) {
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
      }
    } catch {
      /* */
    }
  }
  return {
    hasVideo: true,
    percent,
    duration: Math.round(dur),
    currentTime: Math.round(v.currentTime),
    rate: v.playbackRate,
    muted: v.muted,
    ratio: dur ? v.currentTime / dur : 0,
    atEnd,
    ended: !!v.ended,
  };
}

// 讨论：读「最新一条」评论正文（列表第一个 dl 的 div.cont_detail）。
function readLatestCommentInPage(sel) {
  let list = null;
  for (const css of sel.discuss.list) {
    const e = document.querySelector(css);
    if (e) {
      list = e;
      break;
    }
  }
  if (!list) return "";
  const item = list.querySelector(sel.discuss.item);
  if (!item) return "";
  for (const bc of sel.discuss.body) {
    const b = item.querySelector(bc);
    if (b && (b.innerText || "").trim()) return b.innerText.trim().slice(0, 500);
  }
  return (item.innerText || "").trim().slice(0, 300);
}

function markDiscussInputInPage(sel) {
  for (const css of sel.discuss.input) {
    const e = document.querySelector(css);
    if (e) {
      e.setAttribute("data-watch-input", "1");
      return true;
    }
  }
  return false;
}

// ===================== Node 侧 =====================

// 找并等待「学习内容」iframe（含 .leaf-detail）就绪。
async function contentFrame(page) {
  const find = () => page.frames().find((fr) => SEL.contentFrameUrl.some((k) => (fr.url() || "").includes(k)));
  for (let i = 0; i < 24; i += 1) {
    const f = find();
    if (f) {
      const ready = await f.evaluate((s) => !!document.querySelector(s.leaf.row), SEL).catch(() => false);
      if (ready) return f;
    }
    await sleep(800);
  }
  return find() || page.mainFrame();
}

// goto 课程页 → 点「学习内容」(#tab-content) → 进入 iframe、展开。返回内容 frame。
export async function gotoContentTab(page, listUrl) {
  if (!/studentLog/.test(page.url())) {
    await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  }
  await page.waitForSelector(SEL.tabContent, { timeout: 20000 }).catch(() => {});
  await dismissPopups(page).catch(() => {});
  const tab = page.locator(SEL.tabContent).first();
  if (await tab.count().catch(() => 0)) {
    await tab.click({ timeout: 6000 }).catch(() => {});
  } else {
    await page.getByText(SEL.tabContentText, { exact: true }).first().click({ timeout: 6000 }).catch(() => {});
  }
  await sleep(2000);
  const frame = await contentFrame(page);
  await frame.evaluate(expandLeavesInPage, SEL).catch(() => {});
  await sleep(800);
  return frame;
}

// 点开第 idx 个叶子（在 iframe 内点击 → 顶层跳转）。返回 { surface, navigated }。
async function openUnit(listPage, idx) {
  const frame = await contentFrame(listPage);
  const before = listPage.url();
  const leaf = frame.locator(`[data-watch-idx="${idx}"]`).first();
  await leaf.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
  const titleLoc = frame.locator(`[data-watch-idx="${idx}"] ${SEL.leaf.title}`).first();
  const target = (await titleLoc.count().catch(() => 0)) ? titleLoc : leaf;
  await target.click({ timeout: 6000 }).catch(async () => {
    await leaf.click({ timeout: 4000, force: true }).catch(() => {});
  });

  // 等顶层 URL 变化（详情页是顶层整页）
  for (let i = 0; i < 16; i += 1) {
    await sleep(500);
    if (listPage.url() !== before) {
      await listPage.waitForLoadState("domcontentloaded").catch(() => {});
      await sleep(1500);
      return { surface: listPage, navigated: true };
    }
  }
  // 顶层未变：兜底看是否某 frame 跳到了详情
  const detail = listPage.frames().find((fr) => /video-student|\/forum|\/xcloud\/video/.test(fr.url() || ""));
  if (detail) {
    await sleep(1200);
    return { surface: detail, navigated: true };
  }
  return { surface: listPage, navigated: false };
}

// 按详情页 URL / DOM 判类型（surface 可为 Page 或 Frame）。
async function detectKind(surface) {
  const url = surface.url();
  const hit = (arr) => arr.some((k) => url.includes(k));
  if (hit(SEL.urlKind.video)) return "video";
  if (hit(SEL.urlKind.discuss)) return "discuss";
  if (hit(SEL.urlKind.exercise)) return "exercise";
  if (await surface.evaluate(() => !!document.querySelector("video")).catch(() => false)) return "video";
  if (
    await surface
      .evaluate(() => !!(document.querySelector(".new_discuss_list") && document.querySelector("textarea")))
      .catch(() => false)
  )
    return "discuss";
  return "read";
}

// 看视频：设速+静音+播放，轮询完成度；到末尾耐心收尾（重播末段）直到完成度达标再走。
// 返回 done | incomplete(x%) | stuck(x%) | timeout(x%) | novideo。
async function watchVideo(args, surface, logger, label) {
  let ok = await surface.evaluate(hasVideoInPage).catch(() => false);
  if (!ok) {
    await sleep(2500);
    ok = await surface.evaluate(hasVideoInPage).catch(() => false);
    if (!ok) return "novideo";
  }

  const arg = {
    speed: args.speed,
    mute: args.mute,
    doneThreshold: SEL.doneThreshold,
    progressSel: SEL.player.progressText,
  };
  const uiArg = { speed: args.speed, mute: args.mute, ui: SEL.player.ui };
  const uiBeforePlay = await surface.evaluate(applyPlayerUiInPage, uiArg).catch(() => null); // 先 claim UI，避免播放后漏音
  ok = await surface.evaluate(setupVideoInPage, { speed: args.speed, mute: args.mute }).catch(() => false);
  if (!ok) return "novideo";
  const uiAfterPlay = await surface.evaluate(applyPlayerUiInPage, uiArg).catch(() => null); // 播放器渲染滞后时再补一次
  const uiState =
    [uiBeforePlay, uiAfterPlay].find((x) => x && (x.speedSet || x.muteSet)) || uiAfterPlay || uiBeforePlay;
  if (uiState && (uiState.speedSet || uiState.muteSet)) {
    const speedNote = uiState.speedSet
      ? `倍速 ${uiState.speedLabel || "?"}->${uiState.speedAfter || "?"}${uiState.speedKey ? ` keyt=${uiState.speedKey}` : ""}`
      : "";
    const muteNote = uiState.muteSet ? `静音 ${uiState.volText || "?"}->${uiState.volAfter || "?"}` : "";
    logger.note(`    播放器UI已处理${speedNote || muteNote ? "：" : ""}${[speedNote, muteNote].filter(Boolean).join("；")}`);
  }
  const start = Date.now();
  const hardCap = 40 * 60 * 1000; // 单视频硬上限
  let endedSince = 0; // 首次到末尾的时刻（收尾计时）
  let lastPct = -1;
  let lastPctChangeAt = Date.now();

  for (;;) {
    await sleep(args.watchPollMs);
    await surface.evaluate(applyPlayerUiInPage, uiArg).catch(() => {}); // 每轮幂等保持 UI 静音/倍速
    const st = await surface.evaluate(keepWatchingInPage, arg).catch(() => null);
    if (!st) continue;
    const pct = st.percent != null ? st.percent : Math.round(st.ratio * 100);
    logger.note(
      `    ${label} 完成度 ${pct}%${st.duration ? ` (${st.currentTime}/${st.duration}s ${st.rate}x${st.muted ? " 静音" : ""}${st.atEnd ? " 末尾·等结算" : ""})` : ""}`,
    );

    if (pct >= SEL.doneThreshold) {
      await surface
        .evaluate(() => {
          const v = document.querySelector("video");
          if (v && !v.paused) v.pause();
        })
        .catch(() => {});
      return "done";
    }

    if (pct !== lastPct) {
      lastPct = pct;
      lastPctChangeAt = Date.now();
    }

    if (st.atEnd) {
      if (!endedSince) endedSince = Date.now();
      // 末尾等服务端结算：完成度 45s 不再变化、或总收尾超 120s，就不傻等
      if (Date.now() - lastPctChangeAt > 45000 || Date.now() - endedSince > 120000) return `incomplete(${pct}%)`;
    } else {
      endedSince = 0;
      if (Date.now() - lastPctChangeAt > 120000) return `stuck(${pct}%)`; // 播放中完成度 2min 不动=卡住
    }
    if (Date.now() - start > hardCap) return `timeout(${pct}%)`;
  }
}

// 看图文/课件：滚到底并停留。返回 done。
async function watchRead(args, surface) {
  const frames = typeof surface.frames === "function" ? surface.frames() : [surface];
  for (const f of frames) {
    for (let i = 0; i < 4; i += 1) {
      await f.evaluate(() => window.scrollTo(0, document.body ? document.body.scrollHeight : 0)).catch(() => {});
      await sleep(700);
    }
  }
  await sleep(1500);
  return "done";
}

// 讨论：复制最新评论正文，原样发送。返回 done|skip|fail。
async function doDiscuss(args, surface, logger, label) {
  await surface.waitForSelector(SEL.discuss.list[0], { timeout: 8000 }).catch(() => {});
  const latest = await surface.evaluate(readLatestCommentInPage, SEL).catch(() => "");
  if (!latest) {
    logger.note(`    ${label} 未取到评论，跳过`);
    return "skip";
  }
  const found = await surface.evaluate(markDiscussInputInPage, SEL).catch(() => false);
  if (!found) {
    logger.note(`    ${label} 未找到回复输入框，跳过`);
    return "skip";
  }
  const input = surface.locator('[data-watch-input="1"]').first();
  await input.click({ timeout: 4000 }).catch(() => {});
  await input.fill(latest).catch(async () => {
    await input.type(latest).catch(() => {});
  });
  await sleep(500);

  let sent = false;
  for (const word of SEL.discuss.sendText) {
    const btns = surface.getByText(word, { exact: true });
    const n = await btns.count().catch(() => 0);
    for (let i = 0; i < n; i += 1) {
      const b = btns.nth(i);
      if (await b.isVisible().catch(() => false)) {
        await b.click({ timeout: 3000 }).catch(() => {});
        sent = true;
        break;
      }
    }
    if (sent) break;
  }
  await sleep(1200);
  logger.note(`    ${label} ${sent ? "已发送" : "已填未发"}：「${latest.slice(0, 28)}…」`);
  return sent ? "done" : "fail";
}

// 回到学习内容列表（顶层 goBack → 重进学习内容）。
async function returnToList(listPage, listUrl) {
  await listPage.goBack({ timeout: 8000 }).catch(() => {});
  await sleep(1500);
  await gotoContentTab(listPage, listUrl);
}

/**
 * 刷课主循环。listPage 为课程所在标签页。
 * 返回 { done, skipped, failed, total }。
 */
export async function runWatch(args, context, listPage, logger, listUrl) {
  await gotoContentTab(listPage, listUrl);

  let done = 0;
  let skipped = 0;
  let failed = 0;
  let total = 0;
  let guard = 0;
  const processed = new Set();

  for (;;) {
    if (args.maxUnits && done >= args.maxUnits) {
      logger.note(`已达上限 ${args.maxUnits} 个单元，停止。`);
      break;
    }
    if (guard++ > 800) {
      logger.note("达到安全上限，停止。");
      break;
    }

    const frame = await contentFrame(listPage);
    const units = await frame.evaluate(collectUnitsInPage, SEL).catch(() => []);
    total = Math.max(total, units.length);

    const target = units.find(
      (u) =>
        u.status !== "done" &&
        !processed.has(u.title) &&
        (!args.onlyChapter || u.title.includes(args.onlyChapter)),
    );
    if (!target) {
      logger.note(`没有更多未完成单元（本轮枚举 ${units.length} 个）。`);
      break;
    }
    processed.add(target.title);

    if (target.hint === "exercise") {
      skipped += 1;
      logger.note(`跳过(作业): ${target.title}`);
      continue;
    }

    logger.note(`▶ ${target.title}（图标判型: ${target.hint}）`);
    const opened = await openUnit(listPage, target.idx);
    if (!opened.navigated) {
      failed += 1;
      logger.note(`  ✗ 打开失败(顶层URL未变化)：${target.title}`);
      await returnToList(listPage, listUrl);
      continue;
    }

    const kind = await detectKind(opened.surface);
    let result;
    try {
      if (kind === "video") result = await watchVideo(args, opened.surface, logger, target.title);
      else if (kind === "discuss") result = args.discuss ? await doDiscuss(args, opened.surface, logger, target.title) : "skip(讨论未开启)";
      else if (kind === "exercise") result = "skip(作业)";
      else result = await watchRead(args, opened.surface);
    } catch (e) {
      result = "error:" + (e.message || e);
    }

    if (result === "done") {
      done += 1;
      logger.note(`  ✓ 完成：${target.title}`);
    } else if (String(result).startsWith("skip")) {
      skipped += 1;
      logger.note(`  - 跳过(${result})：${target.title}`);
    } else {
      failed += 1;
      logger.note(`  ✗ 未完成(${result})：${target.title}`);
    }

    await returnToList(listPage, listUrl);
    await sleep(args.delayMs);
  }

  return { done, skipped, failed, total };
}
