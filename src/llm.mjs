// 火山方舟（OpenAI 兼容）视觉调用 + 答案解析。
// 因为题干/选项是加密字体（DOM 文本是乱码），改为把题目截图发给视觉模型来读，返回选项字母。

const QUESTION_TYPE_LABEL = {
  single: "单选题（恰好一个正确选项）",
  multiple: "多选题（可能有多个正确选项，请全部选出）",
  judge: "判断题（在给出的选项中选一个）",
};

// question: { type, options:[{label}], imageBase64 }
function buildMessages(question) {
  const isJudge = question.type === "judge";
  const typeLabel = QUESTION_TYPE_LABEL[question.type] || "选择题";
  const letters = question.options.map((o) => o.label).join("、");

  const system = isJudge
    ? "你是严谨的答题助手。图片里是一道判断题（题干 + ✓正确 / ✗错误 两个选项）。" +
      "判断题干的说法是否正确。" +
      "只输出一个 JSON 对象，不要任何额外文字、不要 markdown 代码块。" +
      '格式：{"answer":["A"或"B"],"reason":"简短理由"}。其中 A=正确(✓)，B=错误(✗)。'
    : "你是严谨的答题助手。图片里是一道题（含题干和带字母的选项）。" +
      "仔细阅读图片内容判断正确答案。" +
      "只输出一个 JSON 对象，不要任何额外文字、不要 markdown 代码块。" +
      '格式：{"answer":["选项字母"],"reason":"简短理由"}。' +
      "answer 只能包含给定的选项字母；多选题列出所有正确项，单选题只列一个。";

  const userText = isJudge
    ? "这是一道判断题。若题干说法【正确】答 A，【错误】答 B。请阅读图片后只返回 JSON。"
    : `题型：${typeLabel}\n` +
      `本题可选选项字母：${letters}\n` +
      "请阅读图片中的题干与选项后作答，只返回 JSON。";

  return [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:image/png;base64,${question.imageBase64}` } },
        { type: "text", text: userText },
      ],
    },
  ];
}

// 从模型输出里尽力解析出答案字母数组（大写、去重、限定在可选字母内）。
function parseAnswer(content, question) {
  const validSet = new Set(question.options.map((o) => o.label));
  const isJudge = question.type === "judge";
  const picks = new Set();
  const addLetter = (s) => {
    const up = String(s || "").trim().toUpperCase();
    if (validSet.has(up)) picks.add(up);
  };
  // 判断题：把 对/错/正确/错误/T/F/true/false 映射到 A(正确)/B(错误)
  const mapJudge = (s) => {
    if (!isJudge) return;
    const t = String(s || "");
    if (/错误|错|false|×|✗|✘|否|\bF\b/i.test(t)) addLetter("B");
    else if (/正确|对|true|√|✓|是|\bT\b/i.test(t)) addLetter("A");
  };

  let jsonAns = null;
  const objMatch = content.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const obj = JSON.parse(objMatch[0]);
      if (obj && obj.answer !== undefined) jsonAns = obj.answer;
    } catch {
      /* fall through */
    }
  }
  if (jsonAns !== null) {
    const arr = Array.isArray(jsonAns) ? jsonAns : [jsonAns];
    for (const item of arr) {
      const letters = String(item).toUpperCase().match(/[A-H]/g);
      if (letters) letters.forEach(addLetter);
      mapJudge(item);
    }
  }
  // 兜底：全文捞独立字母
  if (!picks.size) {
    const letters = content.toUpperCase().match(/(?<![A-Z])[A-H](?![A-Z])/g) || [];
    letters.forEach(addLetter);
  }
  // 判断题兜底：从全文判断对/错
  if (!picks.size) mapJudge(content);
  return [...picks].sort();
}

function getReason(content) {
  const m = content.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]).reason || "";
    } catch {
      /* ignore */
    }
  }
  return "";
}

function validate(answer, question) {
  if (!answer.length) return false;
  if (question.type === "single" || question.type === "judge") return answer.length === 1;
  return answer.length >= 1; // multiple
}

async function callArkOnce(args, messages, { timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${args.apiBase.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: args.model, temperature: 0, messages }),
      signal: controller.signal,
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      const msg = body?.error?.message || text || res.statusText;
      throw new Error(`方舟 HTTP ${res.status}: ${msg}`);
    }
    return body?.choices?.[0]?.message?.content || "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解一道题（视觉）。返回 { ok, answer:[字母], reason, raw, error }。
 * 解析无效则带提醒重试一次；网络错误重试 networkRetries 次。
 */
export async function solveQuestion(args, question, { networkRetries = 2 } = {}) {
  const baseMessages = buildMessages(question);
  let lastErr = "";
  let lastRaw = "";

  for (let attempt = 0; attempt <= 1; attempt += 1) {
    const msgs =
      attempt === 0
        ? baseMessages
        : [
            ...baseMessages,
            {
              role: "system",
              content:
                "上一次输出未能解析出有效选项。请严格只输出 JSON，" +
                'answer 数组里只放给定的选项字母，例如 {"answer":["A"]}。',
            },
          ];

    let content = "";
    let netErr = "";
    for (let n = 0; n <= networkRetries; n += 1) {
      try {
        content = await callArkOnce(args, msgs);
        netErr = "";
        break;
      } catch (e) {
        netErr = e.message;
        await new Promise((r) => setTimeout(r, 500 * (n + 1)));
      }
    }
    if (netErr) {
      lastErr = netErr;
      continue;
    }

    lastRaw = content;
    const answer = parseAnswer(content, question);
    if (validate(answer, question)) {
      return { ok: true, answer, reason: getReason(content), raw: content };
    }
    lastErr = `无法解析出有效${question.type === "multiple" ? "多选" : "单选"}答案`;
  }

  return { ok: false, answer: [], reason: "", raw: lastRaw, error: lastErr };
}
