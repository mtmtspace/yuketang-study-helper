import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { PROJECT_ROOT } from "./config.mjs";

function normKey(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeFillAnswer(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (/^(true|t|正确|对|是)$/i.test(text)) return "true";
  if (/^(false|f|错误|错|否)$/i.test(text)) return "false";
  return text;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function normalizeAnswerItems(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.items)) return parsed.items;
  if (Array.isArray(parsed?.answers) && parsed.answers.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
    return parsed.answers;
  }
  if (parsed?.answers && typeof parsed.answers === "object" && !Array.isArray(parsed.answers)) {
    return Object.entries(parsed.answers).map(([index, answer]) => ({ index, answer }));
  }
  return [];
}

function loadStore(args) {
  if (args._agentAnswersLoaded) return args._agentAnswers;
  args._agentAnswersLoaded = true;
  if (!args.answersFile) {
    args._agentAnswers = { path: "", items: [], byKey: new Map() };
    return args._agentAnswers;
  }

  const path = isAbsolute(args.answersFile) ? args.answersFile : resolve(PROJECT_ROOT, args.answersFile);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const items = normalizeAnswerItems(parsed);
  const byKey = new Map();
  for (const item of items) {
    for (const key of [item.index, item.id, item.questionId, item.key]) {
      const k = normKey(key);
      if (k) byKey.set(k, item);
    }
  }
  args._agentAnswers = { path, items, byKey };
  return args._agentAnswers;
}

function pickItem(store, keys) {
  for (const key of keys) {
    const item = store.byKey.get(normKey(key));
    if (item) return item;
  }
  return null;
}

function parseChoiceAnswer(raw, validLetters) {
  const valid = new Set((validLetters || []).map((x) => String(x).toUpperCase()));
  const out = [];
  for (const value of toArray(raw)) {
    const letters = String(value ?? "").toUpperCase().match(/[A-H]/g) || [];
    for (const letter of letters) {
      if ((!valid.size || valid.has(letter)) && !out.includes(letter)) out.push(letter);
    }
  }
  return out.sort();
}

function parseFillAnswers(raw, expectedCount) {
  const answers = toArray(raw).map(normalizeFillAnswer).filter(Boolean);
  if (expectedCount > 0) return answers.slice(0, expectedCount);
  return answers;
}

export function usesAgentSolver(args) {
  return !!(args.agentDump || args.answersFile);
}

export function getAgentAnswer(args, spec) {
  const store = loadStore(args);
  const keys = [
    spec.index,
    spec.questionId,
    spec.id,
    spec.shortIndex,
    spec.shortIndex != null ? String(spec.shortIndex) : "",
  ];
  const item = pickItem(store, keys);
  if (!item) {
    return {
      ok: false,
      answers: [],
      error: `answers-file 未找到题目 ${spec.index || spec.questionId || spec.shortIndex || "?"} 的答案`,
    };
  }

  const raw = item.answers ?? item.answer ?? item.value ?? item.values;
  const kind = spec.kind || spec.answerKind || "choice";
  const answers =
    kind === "fill"
      ? parseFillAnswers(raw, Number(spec.expectedCount || 0))
      : parseChoiceAnswer(raw, spec.validLetters || spec.options || []);
  const expectedCount = Number(spec.expectedCount || 0);
  if (!answers.length) {
    return { ok: false, answers: [], error: `answers-file 中 ${item.index || item.id || spec.index} 的答案为空或无效` };
  }
  if (kind === "choice" && (spec.type === "single" || spec.type === "judge") && answers.length !== 1) {
    return { ok: false, answers: [], error: `${spec.type} 题需要 1 个选项，当前为 ${answers.join("")}` };
  }
  if (kind === "fill" && expectedCount > 0 && answers.length !== expectedCount) {
    return { ok: false, answers: [], error: `填空题需要 ${expectedCount} 个答案，当前为 ${answers.length} 个` };
  }
  return { ok: true, answers, reason: item.reason || "agent：使用 answers-file 人工答案", raw: item };
}
