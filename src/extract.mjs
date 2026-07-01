// 题目提取（在页面上下文执行的纯函数）。
// 雨课堂用 Element UI + 字体反爬：题型/字母/按钮是干净文本，题干和选项正文是加密字体（乱码）。
// 所以这里只取“结构信息”（题型、每个选项的字母、可点元素），正文交给视觉模型从截图里读。
//
// 选择器依据 output/inspect/snapshot-01 实测：
//   题目容器  .subject-item
//   选项      label.el-radio.homeworkElRadio （多选为 label.el-checkbox）
//   字母      span.radioInput（"A"）/ input[value="A"]
//   选中态    label 含 is-checked

// 在页面里执行：定位当前可见题目，给容器/选项打标，返回结构化数据。
// options.rootSelector 可限制在某个题块内，用于新版 studentQuiz iframe 复用旧选择题逻辑。
export function extractInPage(cfg = {}) {
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && st.display !== "none" && st.visibility !== "hidden";
  };

  // 清掉上一次的标记，保证选择器唯一
  document.querySelectorAll("[data-aa-id]").forEach((e) => e.removeAttribute("data-aa-id"));
  document.querySelectorAll("[data-aa-q]").forEach((e) => e.removeAttribute("data-aa-q"));

  const optSel = "label.el-radio, label.el-checkbox";
  const roots = cfg.rootSelector ? [document.querySelector(cfg.rootSelector)].filter(Boolean) : [];
  const items = roots.length ? roots : [...document.querySelectorAll(".subject-item, .problem_item")];

  // 取“可见且含可见选项”的题目容器 = 当前题
  let item = items.find((it) => visible(it) && [...it.querySelectorAll(optSel)].some(visible));
  if (!item) item = items.find((it) => it.querySelectorAll(optSel).length > 0);
  if (!item) return { ok: false, error: "未找到含选项的题目容器(.subject-item/.problem_item)" };

  item.setAttribute("data-aa-q", "1");
  const text = item.innerText || "";

  let type = "single";
  if (/多选题|不定项/.test(text)) type = "multiple";
  else if (/判断题/.test(text)) type = "judge";
  else if (/单选题/.test(text)) type = "single";
  else if (item.querySelector('input[type="checkbox"], label.el-checkbox')) type = "multiple";

  const labels = [...item.querySelectorAll(optSel)].filter(visible);
  const options = labels.map((lab, i) => {
    const inp = lab.querySelector("input");
    const value = inp ? String(inp.value || "") : "";
    const letterEl = lab.querySelector(".radioInput, .checkboxInput");
    let letter = (norm(letterEl ? letterEl.innerText : "").match(/[A-Za-z]/) || [""])[0].toUpperCase();

    // 判断题选项没有字母：用 input value (true/false) 或图标判定 正确/错误
    let truth = null;
    if (value === "true") truth = true;
    else if (value === "false") truth = false;
    else {
      const inner = (letterEl || lab).innerHTML || "";
      if (/zhengque|correct|right|gou\b|✓|√/i.test(inner)) truth = true;
      else if (/cuowu|wrong|error|cha\b|✗|×/i.test(inner)) truth = false;
    }

    const checked =
      (inp && inp.checked) ||
      lab.classList.contains("is-checked") ||
      !!lab.querySelector(".is-checked");
    const disabled = (inp && inp.disabled) || lab.classList.contains("is-disabled");

    const aaId = "aa-" + i;
    lab.setAttribute("data-aa-id", aaId);
    return { index: i, letter, truth, checked, disabled, aaId };
  });

  // 判断题：统一字母 true->A(正确) false->B(错误)
  if (type === "judge" || (options.length === 2 && options.every((o) => o.truth !== null))) {
    type = "judge";
    for (const o of options) {
      if (o.truth === true) o.letter = "A";
      else if (o.truth === false) o.letter = "B";
    }
  }
  // 兜底：仍为空的字母按序补 A/B/C...
  options.forEach((o, i) => {
    if (!o.letter) o.letter = String.fromCharCode(65 + i);
  });

  const headerMatch = text.match(/\d+\s*[.、]?\s*(单选题|多选题|判断题|不定项)/);
  return {
    ok: true,
    type,
    header: headerMatch ? norm(headerMatch[0]) : norm(text).slice(0, 24),
    optionCount: options.length,
    options,
    answered: options.some((o) => o.checked),
    locked: options.length > 0 && options.every((o) => o.disabled),
  };
}

// 读取进度（总题数 / 已答数 / 当前题号）。
export function readProgressInPage() {
  const orders = [...document.querySelectorAll(".J_order")];
  let current = null;
  orders.forEach((o, i) => {
    if (o.classList.contains("active") || o.querySelector(".active")) current = i + 1;
  });
  const m = (document.body ? document.body.innerText : "").match(/(\d+)\s*\/\s*(\d+)\s*题/);
  return {
    total: orders.length || (m ? Number(m[2]) : null),
    answeredCount: m ? Number(m[1]) : null,
    current,
  };
}
