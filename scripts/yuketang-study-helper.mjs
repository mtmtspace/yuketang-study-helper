#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_ENDPOINT = "http://127.0.0.1:9222";
const DEFAULT_OUT_DIR = "output/yuketang-study";
const DEFAULT_API_BASE = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_MODEL = "doubao-seed-2-0-lite-260215";

function parseArgs(argv) {
  const args = {
    endpoint: DEFAULT_ENDPOINT,
    outDir: DEFAULT_OUT_DIR,
    urlContains: "changjiang.yuketang.cn",
    titleContains: "",
    targetIndex: null,
    maxQuestions: 30,
    withLlm: false,
    apiBase: DEFAULT_API_BASE,
    apiKeyEnv: "ARK_API_KEY",
    model: DEFAULT_MODEL,
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
    } else if (arg === "--max-questions") {
      args.maxQuestions = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--with-llm") {
      args.withLlm = true;
    } else if (arg === "--api-base") {
      args.apiBase = next;
      i += 1;
    } else if (arg === "--api-key-env") {
      args.apiKeyEnv = next;
      i += 1;
    } else if (arg === "--model") {
      args.model = next;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.maxQuestions) || args.maxQuestions <= 0) {
    throw new Error("--max-questions must be a positive number");
  }

  return args;
}

function printHelp() {
  console.log(`
Extract Yuketang questions for study review.

Usage:
  node scripts/yuketang-study-helper.mjs [options]

Options:
  --endpoint <url>          Chrome debugging endpoint. Default: ${DEFAULT_ENDPOINT}
  --out <dir>               Output directory. Default: ${DEFAULT_OUT_DIR}
  --url-contains <text>     Pick a tab whose URL contains this text.
                            Default: changjiang.yuketang.cn
  --title-contains <text>   Optional title filter.
  --target-index <number>   Pick from the printed matching target list.
  --max-questions <number>  Max extracted questions. Default: 30
  --with-llm                Call the model and write study-notes.md.
  --api-base <url>          OpenAI-compatible API base.
                            Default: ${DEFAULT_API_BASE}
  --api-key-env <name>      Environment variable containing the API key.
                            Default: ARK_API_KEY
  --model <name>            Model name. Default: ${DEFAULT_MODEL}
  -h, --help                Show this help.

Safety:
  This script extracts questions/options and generates study notes.
  It does not click answers, fill forms, or submit anything.
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

async function fetchTargets(endpoint) {
  const errors = [];
  for (const path of ["/json", "/json/list"]) {
    try {
      return await fetchJson(`${endpoint}${path}`);
    } catch (error) {
      errors.push(`${path}: ${error.message}`);
    }
  }
  throw new Error(`Cannot read Chrome targets. Tried ${errors.join("; ")}`);
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

function extractQuestionsFromPage(maxQuestions) {
  const normalize = (value) =>
    String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

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

  const cssEscape = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };

  const selectorFor = (el) => {
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
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    if (role) {
      return `${tag}[role="${role}"]${className}`;
    }
    return `${tag}${className}`;
  };

  const optionLinePattern =
    /^(?:([A-Ha-h])[\s.．、:：)]|[（(]([A-Ha-h])[）)]|([①②③④⑤⑥⑦⑧]))\s*(.+)$/;

  const normalizeOptionKey = (raw, index) => {
    if (!raw) {
      return String.fromCharCode(65 + index);
    }
    const circled = "①②③④⑤⑥⑦⑧";
    const circledIndex = circled.indexOf(raw);
    if (circledIndex >= 0) {
      return String.fromCharCode(65 + circledIndex);
    }
    return raw.toUpperCase();
  };

  const parseOptions = (text) => {
    const lines = normalize(text)
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const options = [];

    for (const line of lines) {
      const match = line.match(optionLinePattern);
      if (!match) {
        continue;
      }
      const rawKey = match[1] || match[2] || match[3];
      const label = normalizeOptionKey(rawKey, options.length);
      const optionText = normalize(match[4]);
      if (optionText) {
        options.push({ label, text: optionText });
      }
    }

    return options;
  };

  const questionKeywords =
    /(single choice|multiple choice|true\/false|question|quiz|单选|多选|判断|填空|简答|问答|题目|第\s*\d+\s*题)/i;

  const looksLikeQuestion = (text) =>
    questionKeywords.test(text) || parseOptions(text).length >= 2;

  const splitVisibleText = (text) => {
    const normalized = normalize(text);
    const chunks = normalized
      .split(/\n(?=(?:第\s*\d+\s*题|[0-9]{1,3}[.．、]\s*|Q[0-9]{1,3}[.．、:\s]))/i)
      .map((chunk) => normalize(chunk))
      .filter((chunk) => chunk.length >= 12);
    return chunks.length > 1 ? chunks : [normalized];
  };

  const textBeforeOptions = (text, options) => {
    if (!options.length) {
      return normalize(text);
    }
    const lines = normalize(text).split(/\n+/);
    const firstOptionIndex = lines.findIndex((line) =>
      optionLinePattern.test(line.trim()),
    );
    if (firstOptionIndex < 0) {
      return normalize(text);
    }
    return normalize(lines.slice(0, firstOptionIndex).join("\n"));
  };

  const buildQuestion = (source, text, selector = "") => {
    const options = parseOptions(text);
    const prompt = textBeforeOptions(text, options);
    return {
      source,
      selector,
      prompt,
      options,
      rawText: normalize(text),
    };
  };

  const scoreCandidate = (text, el) => {
    const options = parseOptions(text);
    const controls = el
      ? el.querySelectorAll(
          'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]',
        ).length
      : 0;
    let score = 0;
    score += Math.min(options.length, 8) * 3;
    score += Math.min(controls, 8) * 2;
    if (questionKeywords.test(text)) {
      score += 4;
    }
    if (/(submit|提交|保存|下一题|上一题)/i.test(text)) {
      score -= 3;
    }
    if (text.length > 2500) {
      score -= 4;
    }
    return score;
  };

  const candidates = [];
  const elements = Array.from(document.body?.querySelectorAll("*") || []);

  for (const el of elements) {
    if (!isVisible(el)) {
      continue;
    }
    const text = normalize(el.innerText || el.textContent || "");
    if (text.length < 12 || text.length > 5000 || !looksLikeQuestion(text)) {
      continue;
    }
    const score = scoreCandidate(text, el);
    if (score < 5) {
      continue;
    }
    candidates.push({
      question: buildQuestion("dom", text, selectorFor(el)),
      score,
      textLength: text.length,
    });
  }

  const visibleText = document.body ? document.body.innerText : "";
  for (const chunk of splitVisibleText(visibleText)) {
    if (!looksLikeQuestion(chunk)) {
      continue;
    }
    const score = scoreCandidate(chunk, null);
    if (score < 5) {
      continue;
    }
    candidates.push({
      question: buildQuestion("visible-text", chunk),
      score,
      textLength: chunk.length,
    });
  }

  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      b.question.options.length - a.question.options.length ||
      a.textLength - b.textLength,
  );

  const selected = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const key = candidate.question.rawText
      .toLowerCase()
      .replace(/\s+/g, "")
      .slice(0, 500);
    if (seen.has(key)) {
      continue;
    }
    const isDuplicate = selected.some((existing) => {
      const a = existing.rawText.replace(/\s+/g, "");
      const b = candidate.question.rawText.replace(/\s+/g, "");
      return a.includes(b) || b.includes(a);
    });
    if (isDuplicate) {
      continue;
    }
    seen.add(key);
    selected.push(candidate.question);
    if (selected.length >= maxQuestions) {
      break;
    }
  }

  return {
    capturedAt: new Date().toISOString(),
    title: document.title,
    url: location.href,
    questions: selected.map((question, index) => ({
      id: index + 1,
      ...question,
    })),
  };
}

function buildStudyPrompt(question) {
  const optionLines = question.options.length
    ? question.options
        .map((option) => `${option.label}. ${option.text}`)
        .join("\n")
    : "(No structured options were detected.)";

  return `Question ${question.id}

Prompt:
${question.prompt || question.rawText}

Options:
${optionLines}

Please explain the relevant concepts and how a student should reason through this item. Do not choose a final option, do not output an answer key, and do not tell the student what to click.`;
}

async function callChatCompletions(args, apiKey, question) {
  const apiBase = args.apiBase.replace(/\/+$/, "");
  const response = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: args.model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You are a careful study tutor. Help the learner understand the question, but do not provide a direct final answer or option letter.",
        },
        {
          role: "user",
          content: buildStudyPrompt(question),
        },
      ],
    }),
  });

  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = { raw: bodyText };
  }

  if (!response.ok) {
    const message = body?.error?.message || bodyText || response.statusText;
    throw new Error(`LLM request failed: HTTP ${response.status} ${message}`);
  }

  return body?.choices?.[0]?.message?.content || "";
}

function renderQuestionMarkdown(question) {
  const lines = [`## Question ${question.id}`, ""];
  lines.push(`Source: ${question.source}${question.selector ? ` (${question.selector})` : ""}`);
  lines.push("");
  lines.push(question.prompt || question.rawText);
  lines.push("");

  if (question.options.length) {
    lines.push("Options:");
    for (const option of question.options) {
      lines.push(`- ${option.label}. ${option.text}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function writeStudyNotes(args, outDir, dump) {
  const apiKey = process.env[args.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `--with-llm was set but environment variable ${args.apiKeyEnv} is empty`,
    );
  }

  const lines = [
    "# Yuketang Study Notes",
    "",
    `Captured: ${dump.capturedAt}`,
    `Title: ${dump.title}`,
    `URL: ${dump.url}`,
    "",
    "These notes are for study review only. They intentionally avoid answer keys and automated page actions.",
    "",
  ];

  for (const question of dump.questions) {
    lines.push(renderQuestionMarkdown(question));
    lines.push("Study notes:");
    try {
      const note = await callChatCompletions(args, apiKey, question);
      lines.push(note || "(The model returned an empty note.)");
    } catch (error) {
      lines.push(`LLM error: ${error.message}`);
    }
    lines.push("");
  }

  await writeFile(resolve(outDir, "study-notes.md"), `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const endpoint = args.endpoint.replace(/\/+$/, "");
  const targets = await fetchTargets(endpoint);
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

    const expression = `(${extractQuestionsFromPage.toString()})(${JSON.stringify(args.maxQuestions)})`;
    const result = await client.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Page evaluation failed");
    }

    const dump = result.result.value;
    const outDir = resolve(args.outDir);
    await mkdir(outDir, { recursive: true });

    await writeFile(
      resolve(outDir, "questions.json"),
      JSON.stringify(
        {
          ...dump,
          matchingTargets: matches.map((match, index) => ({
            index,
            title: match.title,
            url: match.url,
          })),
        },
        null,
        2,
      ),
      "utf8",
    );

    const questionMarkdown = [
      "# Extracted Yuketang Questions",
      "",
      `Captured: ${dump.capturedAt}`,
      `Title: ${dump.title}`,
      `URL: ${dump.url}`,
      "",
      ...dump.questions.map(renderQuestionMarkdown),
    ].join("\n");
    await writeFile(resolve(outDir, "questions.md"), `${questionMarkdown}\n`, "utf8");

    if (args.withLlm) {
      await writeStudyNotes(args, outDir, dump);
    }

    console.log(`Saved study files to: ${outDir}`);
    console.log(`Questions extracted: ${dump.questions.length}`);
    console.log(`Questions JSON: ${resolve(outDir, "questions.json")}`);
    console.log(`Questions Markdown: ${resolve(outDir, "questions.md")}`);
    if (args.withLlm) {
      console.log(`Study notes: ${resolve(outDir, "study-notes.md")}`);
    }
    console.log("");
    console.log("No page actions were performed.");
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
