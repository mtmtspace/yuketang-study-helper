// 浏览器：用 Playwright 启动“独立配置档”的本机 Chrome（channel:'chrome'，不下载浏览器）。
// 持久化 profile 目录里保存雨课堂登录态，登录一次长期有效。

import { chromium } from "playwright-core";

/**
 * 启动/接管浏览器。返回 { context, page }。
 * - args.cdp 非空：通过 CDP 接管用户已带调试端口启动的 Chrome（不新开浏览器、不关用户浏览器）。
 * - 否则：launchPersistentContext 用独立配置档启动本机 Chrome。
 * page 优先取已匹配雨课堂的标签页，否则取第一个标签页。
 */
export async function launchBrowser(args) {
  if (args.cdp) {
    const browser = await chromium.connectOverCDP(args.cdp);
    const context = browser.contexts()[0] || (await browser.newContext());
    context.__cdpBrowser = browser;
    context.__isCdp = true;
    let page = context.pages()[0];
    if (!page) page = await context.newPage();
    const yk = findYuketangPage(context, args.urlContains);
    return { context, page: yk || page };
  }

  const context = await chromium.launchPersistentContext(args.profileDirAbs, {
    channel: "chrome",
    headless: args.headless,
    viewport: null, // 用真实窗口尺寸，更自然
    acceptDownloads: false,
    args: ["--no-first-run", "--no-default-browser-check", "--start-maximized"],
  });

  // 至少保证有一个页面
  let page = context.pages()[0];
  if (!page) {
    page = await context.newPage();
  }

  const yk = findYuketangPage(context, args.urlContains);
  return { context, page: yk || page };
}

/** 在当前所有标签页里找一个 URL 命中 urlContains 的页面。 */
export function findYuketangPage(context, urlContains) {
  const pages = context.pages().filter((p) => {
    const url = p.url() || "";
    return url.includes(urlContains);
  });
  if (!pages.length) return null;
  // 偏好练习/作业类 URL
  const exercise = pages.find((p) => /exercise|homework|exam|quiz|test/i.test(p.url()));
  return exercise || pages[0];
}

/**
 * 轮询等待出现命中 urlContains 的页面（用户登录并打开作业页时）。
 * 期间监听新开标签页。返回该 page。
 */
export async function waitForYuketangPage(context, urlContains, { timeoutMs = 0, onTick } = {}) {
  const start = Date.now();
  for (;;) {
    const found = findYuketangPage(context, urlContains);
    if (found) return found;
    if (timeoutMs && Date.now() - start > timeoutMs) {
      throw new Error(`等待雨课堂页面超时（未发现 URL 含 "${urlContains}" 的标签页）。`);
    }
    if (onTick) onTick(Math.round((Date.now() - start) / 1000));
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export async function closeBrowser(context) {
  try {
    if (context.__isCdp) {
      // CDP 接管模式：只断开连接，绝不关用户的浏览器/标签页
      if (context.__cdpBrowser) await context.__cdpBrowser.close();
    } else {
      await context.close();
    }
  } catch {
    /* ignore */
  }
}
