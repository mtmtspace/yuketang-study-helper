# Workflows

Use PowerShell on Windows. Run commands from the project root, usually `D:\Works\雨课堂学习助手`.

## Mode Selection

- Single homework: user gives a URL containing `/exercise/`; use `answer`.
- Course-wide homework: user gives a `studentLog` URL and wants homework, not papers/videos; use `course`.
- New quiz papers: user mentions "试卷", `studentQuiz`, fill blanks, 成绩单 paper tags, or final paper hand-in; use `quiz`.
- Course watching: user wants videos/text units/progress; use `watch`. This mode does not need answer JSON.

## Natural-Language Prompts

Ask conversationally, not as a numbered terminal menu. Good minimal questions:

- "把学习日志链接发我。"
- "默认我自己看题目截图来答；如果你想用外部视觉模型 API，也可以给我 Key 来配置。要用默认方式吗？"
- "要只做标题包含某个关键词的吗？"
- "先限制 1 份试跑，还是直接连续处理？"
- "未开始的试卷会开始计时，要包含吗？"
- "默认只填写/保存不提交；你确认要自动提交/交卷吗？"

Accept natural answers such as "默认就行", "用 API", "只做 chap 7", "先一份", "不提交", "包含未开始", and translate them to parameters.

## Solver Choice

Default to Agent self-answer mode:

- Run with `--agent-dump`.
- Inspect `output/run-*.json` and screenshots.
- Write an answers JSON.
- Run with `--answers-file`.

If the user chooses external API mode:

1. Ask for API provider/base/model/key. Any OpenAI-compatible vision model can work.
2. Save or instruct the user to save configuration in `.env`:

```powershell
ARK_API_KEY=<user key>
ARK_API_BASE=<OpenAI-compatible base URL>
ARK_MODEL=<vision model id>
```

3. Run the same mode without `--agent-dump` and without `--answers-file`, for example:

```powershell
npm run agent -- quiz --open-url "<studentLog URL>" --todo --max-homeworks 1
```

Only add `--submit` after explicit confirmation. If API setup fails, fall back to Agent self-answer mode.

## Agent Dump Commands

Single homework:

```powershell
npm run agent -- answer --agent-dump --open-url "<homework URL>" --max-questions 20
```

Course homework:

```powershell
npm run agent -- course --agent-dump --open-url "<studentLog URL>" --only "<keyword>" --max-homeworks 1
```

Quiz papers:

```powershell
npm run agent -- quiz --agent-dump --open-url "<studentLog URL>" --todo --only "<keyword>" --max-homeworks 1
```

If the user explicitly allows starting not-started quiz papers, add:

```powershell
--start-new-quiz
```

After dump, read the printed `日志:` path. The JSON records include `index`, `type`, `options`, `shot`, `answerFormat`, and for fill blanks `blankCount`.

## Apply Commands

Single homework:

```powershell
npm run agent -- answer --answers-file "<answers.json>" --open-url "<homework URL>"
```

Course homework:

```powershell
npm run agent -- course --answers-file "<answers.json>" --open-url "<studentLog URL>" --only "<keyword>" --max-homeworks 1
```

Quiz papers:

```powershell
npm run agent -- quiz --answers-file "<answers.json>" --open-url "<studentLog URL>" --todo --only "<keyword>" --max-homeworks 1
```

Only add `--submit` after explicit confirmation:

```powershell
--submit
```

## Course Watching

Course watching does not need Agent answers:

```powershell
npm run agent -- watch --open-url "<studentLog URL>" --speed 2 --max-units 1
```

Ask before enabling discussion posting:

```powershell
--discuss
```

## Recovery

- If no question records appear, ask the user to log in in the visible Chrome window, then rerun.
- If an answer cannot be inferred from the screenshot, ask the user before guessing.
- If a click/fill mismatch is reported, rerun without `--submit` and inspect the browser plus latest log.
