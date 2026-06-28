#!/usr/bin/env node
// 一次性·只读：打开视频页 → 模拟悬停露出控制条 → 打印「音量/倍速」控件选择器。
// 用途：拿到播放器音量键、倍速菜单的真实选择器，供 watch-loop 点击（彻底静音 + UI 显示 2x）。
// 用法：node scripts/dump-player.mjs            （默认那门课的「五年规划牛在哪」视频）
//      node scripts/dump-player.mjs "<视频页URL>"

import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "../src/config.mjs";
import { launchBrowser } from "../src/browser.mjs";

const VIDEO_URL =
  process.argv.slice(2).find((a) => a.startsWith("http")) ||
  "https://changjiang.yuketang.cn/v2/web/xcloud/video-student/24841495/43336769";

function probePlayer() {
  const out = { xtTags: [], volumeCands: [], speedCands: [], menuItems: [] };
  const root =
    document.querySelector("#video-box, .xtplayer, [class*='xt_video_player_container']") || document.body;
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vis: r.width > 0 && r.height > 0 };
  };
  const clsOf = (el) => (el.className && el.className.toString ? el.className.toString() : "");
  const sel = (el) => {
    if (el.id) return "#" + el.id;
    const c = Array.from(el.classList || []).slice(0, 3).map((x) => "." + x).join("");
    return el.tagName.toLowerCase() + c;
  };
  for (const el of root.querySelectorAll("*")) {
    const tag = el.tagName.toLowerCase();
    const c = clsOf(el);
    const txt = (el.innerText || el.textContent || "").trim();
    const r = rect(el);
    if (tag.startsWith("xt-")) out.xtTags.push({ sel: sel(el), text: txt.slice(0, 18), vis: r.vis, cls: c.slice(0, 80) });
    if (/(volume|mute|sound|yinliang|jingyin)/i.test(c)) out.volumeCands.push({ sel: sel(el), text: txt.slice(0, 18), vis: r.vis, cls: c.slice(0, 90) });
    if (/(speed|rate|playback|beisu)/i.test(c) || /^\s*\d\.\d{1,2}\s*[xX×]\s*$/.test(txt) || /倍速|播放速度/.test(txt))
      out.speedCands.push({ sel: sel(el), text: txt.slice(0, 18), vis: r.vis, cls: c.slice(0, 90) });
    // 倍速菜单项（2.0/2.00/2x 等）
    if (/^\s*(2|2\.0|2\.00|2\.0X|2X|2倍|0\.5|1\.0|1\.5|1\.25|1\.0X|1\.5X)\s*[xX×倍]?\s*$/.test(txt) && txt.length <= 6)
      out.menuItems.push({ sel: sel(el), text: txt, vis: r.vis, cls: c.slice(0, 70), keyt: el.getAttribute && el.getAttribute("keyt") });
  }
  return out;
}

async function revealControls(page) {
  await page
    .evaluate(() => {
      const root = document.querySelector("#video-box, .xtplayer, [class*='xt_video_player_container']");
      if (!root) return;
      const r = root.getBoundingClientRect();
      const fire = (t, x, y) => root.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: x, clientY: y }));
      fire("mouseenter", r.x + r.width / 2, r.y + r.height / 2);
      fire("mousemove", r.x + r.width / 2, r.y + r.height / 2);
      fire("mousemove", r.x + r.width / 2, r.y + r.height - 8);
      fire("mouseover", r.x + r.width / 2, r.y + r.height - 8);
    })
    .catch(() => {});
}

async function main() {
  const args = parseArgs();
  const { page } = await launchBrowser(args);
  console.log("打开视频页：", VIDEO_URL);
  await page.goto(VIDEO_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => console.log("  打开失败：" + e.message));
  await page.waitForSelector("video, #video-box, .xtplayer", { timeout: 20000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3500));

  for (let i = 0; i < 4; i += 1) {
    await revealControls(page);
    await new Promise((r) => setTimeout(r, 600));
  }
  const data = await page.evaluate(probePlayer).catch((e) => ({ error: String(e.message || e) }));

  const show = (title, arr) => {
    console.log(`\n==== ${title} ====`);
    for (const x of arr || []) console.log(`  ${x.sel}  | text="${x.text}" | vis=${x.vis}${x.keyt ? ` | keyt=${x.keyt}` : ""} | ${x.cls}`);
    if (!arr || !arr.length) console.log("  （无）");
  };
  show("xt-* 控件", data.xtTags);
  show("候选 音量/静音 控件", data.volumeCands);
  show("候选 倍速 控件", data.speedCands);
  show("候选 倍速菜单项(2.0/2.00 等)", data.menuItems);

  await mkdir(resolve(args.outDirAbs, "watch-inspect"), { recursive: true }).catch(() => {});
  await writeFile(resolve(args.outDirAbs, "watch-inspect", "player.json"), JSON.stringify(data, null, 2), "utf8").catch(() => {});
  console.log("\n已保存 output/watch-inspect/player.json。浏览器保持打开，按 Ctrl+C 结束。");
}

main().catch((e) => {
  console.error("dump-player 失败:", e.message);
  process.exitCode = 1;
});
