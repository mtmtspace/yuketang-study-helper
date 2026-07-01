# 雨课堂学习助手（Playwright + 视觉大模型）

用 Playwright 驱动本机 Chrome，辅助处理雨课堂作业、新版试卷、课程学习内容和进度核验。作业模式会读取题目 → 调用视觉大模型作答 → 自动勾选选项，**可选自动提交并翻页**；新版试卷可连续处理待做试卷并可选最终交卷；刷课模式会进入学习内容，按进度处理视频/图文单元。

- **连接方式**：默认独立配置档——用你已装的 Chrome 启动一个独立窗口（profile 存 `.chrome-profile/`），雨课堂**登录一次长期保持**，不干扰日常浏览器。也可用 `--cdp` 接管你自己带调试端口启动的 Chrome。
- **提交策略**：默认**只勾选不提交**（做完保持打开供你核对）；加 `--submit` 则**每题选完即点提交、自动翻到下一题**，已提交过的题自动跳过。
- **支持题型**：单选 / 多选 / 判断（可点选项）。填空/简答会自动跳过。
- **读题方式**：雨课堂题干/选项用了**加密字体反爬**（DOM 文本是乱码），所以脚本**截当前题的图 → 发给视觉大模型识别作答**，再按「字母 → 第几个选项」回点。**所用模型必须支持读图（视觉）**。
- **导航**：作业用左侧题号侧边栏逐题确定性遍历；刷课用「学习内容」目录逐个打开未完成单元。

> `scripts/` 下另有**只读**工具（如 `dump-yuketang-page.mjs`、`dump-watch.mjs`、`yuketang-study-helper.mjs`），用于导出页面/核验 DOM/生成复习笔记。

## 准备

需要 Node 18+（已在 Node 24 验证）。安装依赖（用系统 Chrome，不下载浏览器）：

```powershell
# 走代理(Clash)时 npm 可能失败，安装时临时绕过：
$env:HTTP_PROXY=""; $env:HTTPS_PROXY=""; $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="1"
npm install
```

配置 API Key（**别写进源码**）：

```powershell
$env:ARK_API_KEY="你的Key"      # 当前终端临时设置
# 或：copy .env.example .env 后填入
```

## 快速开始（交互式向导 · 推荐给新手）

装好依赖（见上）后，一条命令：

```powershell
npm start
```

按屏幕提示走，全程不用记命令：

1. 首次会让你**粘贴 API Key**（自动存进 `.env`，下次免填）；
2. 自动打开 Chrome —— 在窗口里**登录你的雨课堂**（扫码/账号都行），回终端按回车；
3. 选 **① 单份作业**、**② 批量做整门课**、**③ 新版试卷**，或 **④ 自动刷课**；
4. 作业模式选择：**试运行 / 只勾选不提交 / 勾选并自动提交**；新版试卷可选择**试运行 / 填写并保存 / 填写并交卷 / 只核验结构**；刷课模式按提示填写倍速、静音和单元上限。

> 作业功能需要准备：**一个支持读图的大模型 API Key** + **网址**（浏览器地址栏复制）。
> 作业页网址含 `/exercise/`；整门课作业/自动刷课都用“学习日志”页网址，含 `/studentLog/`。

## Agent / Skill 模式（无需另配模型 API）

如果你有本地 Agent 或类似 AI 助手，可以让 Agent 使用仓库内 Skill：`skills/yuketang-agent/`。这种模式把原来的命令行菜单交给 Agent 用自然语言完成：Agent 询问 URL、范围、是否提交等问题，再调用脚本。

默认情况下，Agent 会自己读取题目截图并作答，不需要另配模型 API；如果你更想用外部视觉模型 API，也可以让 Agent 引导你填写 `.env` 里的 `ARK_API_KEY` / `ARK_API_BASE` / `ARK_MODEL` 后，直接走脚本内置 API 模式。

Agent 两段式答题：

```powershell
# 1) 导出题目截图和结构，不请求模型、不填写
npm run agent -- quiz --agent-dump --open-url "<学习日志页URL>" --todo --max-homeworks 1

# 2) Agent 看 output/run-*.json 和截图，写 answers.json 后回填
npm run agent -- quiz --answers-file "output/agent-answers.json" --open-url "<学习日志页URL>" --todo
```

- `answer`：单份旧作业；`course`：整门课作业；`quiz`：新版试卷；`watch`：刷课。
- `--submit` 仍然是真提交/交卷，只有你明确确认后才应添加。
- 原 `npm start`、`npm run answer/course/quiz/watch` 和外部 API 模式全部保留。

## 模型 / API 服务商

**不限火山方舟**——任何 **OpenAI 兼容接口 + 支持「视觉/读图」的模型**都能用。向导（`npm start`）里可直接选服务商，内置预设：

| 服务商 | API Base | 视觉模型示例 |
|---|---|---|
| 火山方舟 doubao（默认） | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-2-0-lite-260215`（快）/ `-mini-`（慢，带推理） |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` / `gpt-4.1` |
| 阿里通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-plus` |
| 月之暗面 Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-32k-vision-preview` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-VL-72B-Instruct` |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-4o` |

- **不支持 Anthropic 原生接口**（`/v1/messages` 那种，格式不同）；如果中转站只提供 Anthropic 格式则用不了。
- 命令行/脚本里用 `--api-base <url> --model <name>`，或在 `.env` 写 `ARK_API_BASE` / `ARK_MODEL`（`ARK_API_KEY` 存放该服务商的 Key，名字只是沿用，不限火山）。
- 实测准确率约 80–90%（单选/判断较好，多选偏“多选”易扣分），用更强的模型会更准。**不保证全对**。

## 命令行用法（进阶 / 脚本化）

> 不想用向导、想直接命令行或写脚本时用。用 `--open-url` 直接打开页面。

### 首次：登录一次

```powershell
npm run answer -- --open-url "你的作业页URL"
```

弹出独立 Chrome，若跳登录页就**在该窗口登录雨课堂**（登录态存入 `.chrome-profile/`，以后免登）。

### A. 单份作业

```powershell
# 试运行：只读、调模型、记日志，不点选（先看答得对不对）
npm run dry-run -- --open-url "<作业页URL>"

# 勾选但不提交（做完保持打开，你核对后手动交）
npm run answer -- --open-url "<作业页URL>"

# 勾选并自动提交、自动翻页（每题选完即交，已交的跳过）
node src/run.mjs --submit --open-url "<作业页URL>"
```

### B. 整门课批量（遍历所有作业）

给「学习日志 / 成绩单」页 URL（形如 `.../v2/web/studentLog/<classroom_id>?...`）。脚本进入**成绩单**列出全部作业，自动对**未完成**的逐个打开、作答、提交：

```powershell
node src/course.mjs --submit --open-url "<学习日志页URL>"
```

- `--only "第十二章"`：只做标题含该关键字的那份。
- `--force`：连已完成的也重做（慎用）。
- `--max-homeworks 1`：最多做 N 份（先试一份）。

### C. 新版试卷 / 填空题

给「学习日志 / 成绩单」页 URL。脚本会进入**成绩单**，找到带“试卷”标签的 studentQuiz 试卷；当前支持新版填空题，并先套用旧作业模块的单选 / 多选 / 判断题结构。默认只填写/点选并保存题内答案，**不会点最终交卷**：

```powershell
npm run quiz -- --open-url "<学习日志页URL>" --only "T or F questions chap 3" --max-homeworks 1
```

- `--todo`：只处理待做试卷；默认包含“进行中”，配合 `--start-new-quiz` 时包含“未开始”，跳过已得分。
- `--dry-run`：只截图问模型并记录答案，不填写。
- `--no-llm`：只验证页面路径、题面截图和填空框数量，不请求模型、不填写。
- `--answers "true,false,..."`：人工答案覆盖，填空题按空顺序；选择题可传 `A,B` 这类选项字母；不请求模型。
- `--only "T or F"`：只处理标题含该关键字的试卷。
- `--max-homeworks 1`：最多处理 N 份试卷。
- `--force`：包含非“进行中”的试卷，并覆盖已有填空。
- `--start-new-quiz`：允许启动“未开始”试卷（可能开始计时，慎用）。
- `--submit`：每份试卷处理完后自动点击最终交卷（慎用）。

建议先跑 `--no-llm` 看能否进入题面并生成 `output/quiz-shots` 截图；再跑 `--dry-run` 看模型答案和 `output/run-*.json` 日志。如果日志里出现 `HTTP 401` 或 `API key format`，先检查 `.env` / `ARK_API_KEY`。

### D. 自动刷课（学习内容）

给「学习日志 / 成绩单」页 URL（形如 `.../v2/web/studentLog/<classroom_id>?...`）。建议先限制 1 个单元试跑：

```powershell
npm run watch -- --open-url "<学习日志页URL>" --speed 2 --max-units 1
```

- `--speed 2`：视频倍速（默认 2）。
- `--no-mute`：不静音（默认静音）。
- `--only-chapter "第一章"`：只刷标题含该关键字的单元。
- `--max-units 1`：最多处理 N 个学习单元。
- `--discuss`：讨论环节复制最新评论发送（默认关闭，慎用）。

## 常用参数

```powershell
--submit              作业每题提交并翻页；试卷每份处理完后最终交卷
--dry-run             只读不点选，看模型答得对不对
--no-llm              试卷模式只验证页面/截图/填空框，不请求模型
--answers <list>      试卷模式人工答案覆盖，逗号分隔或 JSON 数组
--open-url <url>      启动后直接打开该页面
--cdp <url>           接管你已带 --remote-debugging-port 启动的 Chrome（如 http://127.0.0.1:9222）
--model <name>        换模型（需支持视觉）
--force               已答/已交过的题也重做
--start-question <n>  单份作业从第 n 题开始（run.mjs）
--only <关键字>        批量模式只做匹配的作业（course.mjs）
--max-homeworks <n>   批量模式最多做 n 份（course.mjs）
--todo                试卷模式只处理待做试卷，跳过已得分（quiz.mjs）
--start-new-quiz      试卷模式允许启动未开始试卷（quiz.mjs）
--speed <n>           刷课视频倍速（watch.mjs，默认 2）
--max-units <n>       刷课最多处理 n 个学习单元（watch.mjs）
--delay <ms>          每步间隔毫秒（默认 600）
--exit-when-done      做完自动关闭/断开（默认保持打开）
```

## 安全与注意

- **`--submit` 会真提交，且通常不可逆**（旧作业按题提交；新版试卷按整份最终交卷）。不确定就先 `--dry-run` / `--no-llm`，或不加 `--submit` 只填写再人工核对。
- 大模型不保证 100% 正确，重要作业请提交前核对（看 `output/run-*.json` 或题目截图 `output/shots/`）。
- 新版试卷默认不会点最终交卷；只有你在交互向导确认“填写并交卷”或命令行传 `--submit` 才会自动交卷。
- API Key 经环境变量/`.env` 读取；`.env`、`.chrome-profile/`、`output/` 均已 `.gitignore`。
