#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_ENDPOINT = "http://127.0.0.1:9222";
const DEFAULT_OUT_DIR = "output/yuketang-structure";

function parseArgs(argv) {
  const args = {
    endpoint: DEFAULT_ENDPOINT,
    outDir: DEFAULT_OUT_DIR,
    urlContains: "changjiang.yuketang.cn",
    titleContains: "",
    targetIndex: null,
    maxElements: 1200,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--endpoint") {
      args.endpoint = next;
      i += 1;
    } else if (arg === "--out") {
      args.outDir = next;
      i += 1;
    } else if (arg === "--url-contains") {
      args.urlContains = next;
      i += 1;
    } else if (arg === "--title-contains") {
      args.titleContains = next;
      i += 1;
    } else if (arg === "--target-index") {
      args.targetIndex = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--max-elements") {
      args.maxElements = Number.parseInt(next, 10);
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.maxElements) || args.maxElements <= 0) {
    throw new Error("--max-elements must be a positive number");
  }

  return args;
}

function printHelp() {
  console.log(`
Dump the current Yuketang page structure through Chrome DevTools Protocol.

Usage:
  node scripts/dump-yuketang-page.mjs [options]

Options:
  --endpoint <url>          Chrome debugging endpoint. Default: ${DEFAULT_ENDPOINT}
  --out <dir>               Output directory. Default: ${DEFAULT_OUT_DIR}
  --url-contains <text>     Pick a tab whose URL contains this text.
                            Default: changjiang.yuketang.cn
  --title-contains <text>   Optional title filter.
  --target-index <number>   Pick from the printed matching target list.
  --max-elements <number>   Max DOM elements in structure JSON. Default: 1200
  -h, --help                Show this help.

Notes:
  - This script only reads page structure and saves files.
  - It does not choose answers, click answer options, or submit anything.
`);
}

async function fetchJson(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`Cannot connect to ${url}: ${error.message}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }

  return response.json();
}

function pickTarget(targets, args) {
  const pages = targets.filter((target) => target.type === "page");
  const matches = pages.filter((target) => {
    const urlOk = !args.urlContains || target.url?.includes(args.urlContains);
    const titleOk =
      !args.titleContains || target.title?.includes(args.titleContains);
    return urlOk && titleOk;
  });

  if (args.targetIndex !== null) {
    if (args.targetIndex < 0 || args.targetIndex >= matches.length) {
      throw new Error(
        `--target-index must be between 0 and ${Math.max(matches.length - 1, 0)}`,
      );
    }
    return { target: matches[args.targetIndex], matches };
  }

  const exercise = matches.find((target) =>
    target.url?.includes("/student/exercise/"),
  );
  return { target: exercise || matches[0], matches };
}

function createCdpClient(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      return;
    }

    const request = pending.get(message.id);
    if (!request) {
      return;
    }

    pending.delete(message.id);
    if (message.error) {
      request.reject(
        new Error(`${message.error.message || "CDP error"} (${message.error.code})`),
      );
    } else {
      request.resolve(message.result);
    }
  });

  const opened = new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener(
      "error",
      () => rejectOpen(new Error("Cannot open debugger websocket")),
      { once: true },
    );
  });

  return {
    async send(method, params = {}) {
      await opened;
      const id = nextId;
      nextId += 1;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolveSend, rejectSend) => {
        pending.set(id, { resolve: resolveSend, reject: rejectSend });
      });
    },
    close() {
      socket.close();
    },
  };
}

function pageDump(maxElements) {
  const textLimit = 160;
  const elements = [];
  const selectors = [];
  const tagCounts = {};
  const roleCounts = {};
  const classCounts = {};
  const dataAttrCounts = {};
  const interactive = [];
  const headings = [];
  const frames = [];

  const trim = (value, limit = textLimit) => {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
    return normalized.length > limit
      ? `${normalized.slice(0, limit - 1)}...`
      : normalized;
  };

  const cssEscape = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };

  const elementSelector = (el) => {
    const testId =
      el.getAttribute("data-testid") ||
      el.getAttribute("data-test-id") ||
      el.getAttribute("data-qa") ||
      el.getAttribute("data-cy");
    if (testId) {
      return `[data-testid="${testId}"]`;
    }
    if (el.id) {
      return `#${cssEscape(el.id)}`;
    }
    const className = Array.from(el.classList || [])
      .filter(Boolean)
      .slice(0, 3)
      .map((name) => `.${cssEscape(name)}`)
      .join("");
    const role = el.getAttribute("role");
    const name = el.getAttribute("name");
    const type = el.getAttribute("type");
    if (role) {
      return `${el.tagName.toLowerCase()}[role="${role}"]${className}`;
    }
    if (name) {
      return `${el.tagName.toLowerCase()}[name="${name}"]${className}`;
    }
    if (type) {
      return `${el.tagName.toLowerCase()}[type="${type}"]${className}`;
    }
    return `${el.tagName.toLowerCase()}${className}`;
  };

  const getDepth = (el) => {
    let depth = 0;
    let node = el;
    while (node && node.parentElement) {
      depth += 1;
      node = node.parentElement;
    }
    return depth;
  };

  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  };

  const allElements = Array.from(document.querySelectorAll("*"));
  for (const el of allElements) {
    const tag = el.tagName.toLowerCase();
    tagCounts[tag] = (tagCounts[tag] || 0) + 1;

    const role = el.getAttribute("role");
    if (role) {
      roleCounts[role] = (roleCounts[role] || 0) + 1;
    }

    for (const className of Array.from(el.classList || [])) {
      classCounts[className] = (classCounts[className] || 0) + 1;
    }

    for (const attr of Array.from(el.attributes || [])) {
      if (attr.name.startsWith("data-")) {
        dataAttrCounts[attr.name] = (dataAttrCounts[attr.name] || 0) + 1;
      }
    }
  }

  for (const el of allElements.slice(0, maxElements)) {
    const tag = el.tagName.toLowerCase();
    const attrs = {};
    for (const attr of Array.from(el.attributes || [])) {
      if (
        attr.name === "id" ||
        attr.name === "class" ||
        attr.name === "role" ||
        attr.name === "aria-label" ||
        attr.name === "name" ||
        attr.name === "type" ||
        attr.name === "href" ||
        attr.name === "src" ||
        attr.name.startsWith("data-")
      ) {
        attrs[attr.name] = trim(attr.value, 120);
      }
    }

    const rect = el.getBoundingClientRect();
    const selector = elementSelector(el);
    const text = trim(el.innerText || el.textContent || "", 120);
    const item = {
      depth: getDepth(el),
      tag,
      selector,
      attrs,
      text,
      visible: isVisible(el),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
    elements.push(item);
    selectors.push(selector);

    const interactiveTags = ["a", "button", "input", "select", "textarea", "label"];
    if (
      interactiveTags.includes(tag) ||
      role === "button" ||
      role === "link" ||
      role === "radio" ||
      role === "checkbox"
    ) {
      interactive.push(item);
    }

    if (/^h[1-6]$/.test(tag)) {
      headings.push(item);
    }

    if (tag === "iframe") {
      frames.push(item);
    }
  }

  const topEntries = (object, limit = 60) =>
    Object.entries(object)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([name, count]) => ({ name, count }));

  return {
    capturedAt: new Date().toISOString(),
    title: document.title,
    url: location.href,
    html: document.documentElement.outerHTML,
    visibleText: document.body ? document.body.innerText : "",
    stats: {
      totalElements: allElements.length,
      capturedElements: elements.length,
      tagCounts: topEntries(tagCounts, 80),
      roleCounts: topEntries(roleCounts, 80),
      classCounts: topEntries(classCounts, 120),
      dataAttrCounts: topEntries(dataAttrCounts, 80),
      uniqueSelectors: Array.from(new Set(selectors)).slice(0, 300),
    },
    structure: elements,
    interactive,
    headings,
    frames,
  };
}

function buildOutline(dump, matches) {
  const lines = [
    "# Yuketang Page Structure",
    "",
    `Captured: ${dump.capturedAt}`,
    `Title: ${dump.title}`,
    `URL: ${dump.url}`,
    "",
    "## Matching Chrome Targets",
    "",
  ];

  for (const [index, target] of matches.entries()) {
    lines.push(`${index}. ${target.title || "(untitled)"}`);
    lines.push(`   ${target.url || ""}`);
  }

  lines.push("", "## DOM Stats", "");
  lines.push(`- Total elements on page: ${dump.stats.totalElements}`);
  lines.push(`- Elements captured in JSON: ${dump.stats.capturedElements}`);
  lines.push(`- Interactive elements captured: ${dump.interactive.length}`);
  lines.push(`- Iframes captured: ${dump.frames.length}`);

  lines.push("", "## Top Tags", "");
  for (const entry of dump.stats.tagCounts.slice(0, 30)) {
    lines.push(`- ${entry.name}: ${entry.count}`);
  }

  lines.push("", "## Data Attributes", "");
  for (const entry of dump.stats.dataAttrCounts.slice(0, 40)) {
    lines.push(`- ${entry.name}: ${entry.count}`);
  }

  lines.push("", "## Headings", "");
  for (const item of dump.headings.slice(0, 80)) {
    lines.push(`- ${item.selector}: ${item.text || "(empty)"}`);
  }

  lines.push("", "## Interactive Elements", "");
  for (const item of dump.interactive.slice(0, 200)) {
    const attrs = Object.entries(item.attrs)
      .filter(([name]) => name !== "class")
      .map(([name, value]) => `${name}="${value}"`)
      .join(" ");
    const prefix = attrs ? `${item.selector} ${attrs}` : item.selector;
    lines.push(`- ${prefix}`);
    if (item.text) {
      lines.push(`  text: ${item.text}`);
    }
  }

  lines.push("", "## Common Selector Candidates", "");
  for (const selector of dump.stats.uniqueSelectors.slice(0, 160)) {
    lines.push(`- ${selector}`);
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const endpoint = args.endpoint.replace(/\/+$/, "");
  const targets = await fetchJson(`${endpoint}/json`);
  const { target, matches } = pickTarget(targets, args);

  if (!matches.length) {
    console.log("No matching Chrome targets found.");
    console.log("Available page targets:");
    for (const [index, page] of targets
      .filter((item) => item.type === "page")
      .entries()) {
      console.log(`${index}. ${page.title || "(untitled)"}`);
      console.log(`   ${page.url || ""}`);
    }
    throw new Error("Adjust --url-contains or --title-contains and retry.");
  }

  if (!target?.webSocketDebuggerUrl) {
    throw new Error("The matching Chrome target has no debugger websocket URL.");
  }

  const client = createCdpClient(target.webSocketDebuggerUrl);
  try {
    await client.send("Runtime.enable");
    await client.send("Page.enable");

    const expression = `(${pageDump.toString()})(${JSON.stringify(args.maxElements)})`;
    const result = await client.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.text || "Page evaluation failed",
      );
    }

    const dump = result.result.value;
    const outDir = resolve(args.outDir);
    await mkdir(outDir, { recursive: true });

    await writeFile(resolve(outDir, "page.html"), dump.html, "utf8");
    await writeFile(resolve(outDir, "visible-text.txt"), dump.visibleText, "utf8");
    await writeFile(
      resolve(outDir, "dom-structure.json"),
      JSON.stringify(
        {
          capturedAt: dump.capturedAt,
          title: dump.title,
          url: dump.url,
          stats: dump.stats,
          structure: dump.structure,
          interactive: dump.interactive,
          headings: dump.headings,
          frames: dump.frames,
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(resolve(outDir, "outline.md"), buildOutline(dump, matches), "utf8");

    try {
      const screenshot = await client.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        fromSurface: true,
      });
      await writeFile(
        resolve(outDir, "screenshot.png"),
        Buffer.from(screenshot.data, "base64"),
      );
    } catch (error) {
      await writeFile(
        resolve(outDir, "screenshot-error.txt"),
        `Screenshot capture failed: ${error.message}\n`,
        "utf8",
      );
    }

    console.log(`Saved page dump to: ${outDir}`);
    console.log(`Title: ${dump.title}`);
    console.log(`URL: ${dump.url}`);
    console.log(`HTML: ${resolve(outDir, "page.html")}`);
    console.log(`Outline: ${resolve(outDir, "outline.md")}`);
    console.log(`Structure JSON: ${resolve(outDir, "dom-structure.json")}`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  console.error("");
  console.error("If Chrome is not exposing a debugging endpoint:");
  console.error("1. Close all Chrome windows.");
  console.error("2. Reopen Chrome with:");
  console.error(
    '   "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222',
  );
  console.error("3. Open the Yuketang page again and rerun this script.");
  process.exitCode = 1;
});
