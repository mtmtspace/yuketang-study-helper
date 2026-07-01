---
name: yuketang-agent
description: Agent-facing workflow for using the local Rain Classroom/Yuketang study helper repository. Use when a user wants an AI agent to operate the helper scripts through natural-language interaction for Yuketang/Rain Classroom homework, course-wide homework, studentQuiz papers, or course watching. Default to the agent's own vision/reasoning via --agent-dump and --answers-file, but offer an optional external OpenAI-compatible vision API path and guide API key setup if the user chooses it.
---

# Yuketang Agent

Use this skill as the conversational control layer for the local helper project. Let the user speak naturally; translate their intent into safe script parameters; use the agent's own vision/reasoning for answers by default.

## Core Model

Keep the layers separate:

- Agent: ask the user what to do, infer parameters from natural language, inspect screenshots/logs, produce answers JSON, and confirm risky actions.
- Scripts: open Chrome, keep Yuketang login state, enumerate homework/quiz/course units, screenshot questions, fill answers, save, submit, or watch content.
- Original CLI/API flows: keep available. Do not remove or bypass `npm start`; the Skill path is an additional Agent-operated path.

## Solver Choice

For answer tasks, briefly tell the user:

- Default: the Agent reads exported screenshots and answers with its own vision/reasoning. This needs no external model API.
- Optional: the script can call an external OpenAI-compatible vision API if the user provides a key/base/model.

If the user does not choose API, use the default Agent answer workflow. If the user chooses API, read [workflows.md](references/workflows.md) and follow the API configuration path before running scripts without `--agent-dump` or `--answers-file`.

## First Questions

Ask only for missing information:

- Target: single homework, course-wide homework, studentQuiz paper, or course watching.
- URL: homework URL for single homework; studentLog URL for course homework, quiz papers, or watch mode.
- Scope: title keyword, maximum homeworks/papers/units, and whether to include not-started quiz papers.
- Submission: default to no submit. Add `--submit` only after the user explicitly confirms final submission/hand-in.
- Solver: mention the default Agent self-answer route and optional API route; only configure API if the user chooses it.

If the user says "do the rest", "continue", or similar, infer the likely target from recent context but still confirm any final submission.

## Agent Answer Workflow

For answer tasks in default Agent-self-answer mode, use two passes:

1. Dump questions:
   `npm run agent -- <answer|course|quiz> --agent-dump ...`
2. Read the printed log path, then open the `output/run-*.json` records and the referenced screenshots.
3. Solve each question with the agent's own vision/reasoning.
4. Write an answers file following [answer-schema.md](references/answer-schema.md).
5. Apply answers:
   `npm run agent -- <answer|course|quiz> --answers-file "<answers.json>" ...`

For detailed commands and parameter choices, read [workflows.md](references/workflows.md). Before writing any answers file, read [answer-schema.md](references/answer-schema.md).

## Safety Rules

- Never add `--submit` unless the user explicitly asks to submit/hand in/交卷.
- Before starting not-started quiz papers, ask because it may start timing.
- Use `--max-homeworks 1`, `--max-units 1`, or a narrow `--only` keyword for the first live test unless the user clearly asks for a wider run.
- Keep the browser visible by default so the user can inspect it.
- Do not commit, push, publish, or upload changes unless the user explicitly asks after local verification.
