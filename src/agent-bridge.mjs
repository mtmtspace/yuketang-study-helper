// Agent 桥接入口：统一把自然语言规划后的 mode/参数转发到底层脚本。
// 示例：
//   npm run agent -- quiz --agent-dump --open-url "<studentLog URL>" --todo --max-homeworks 1
//   npm run agent -- quiz --answers-file output/agent-answers.json --open-url "<studentLog URL>"

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "./config.mjs";

const MODES = {
  answer: "src/run.mjs",
  single: "src/run.mjs",
  course: "src/course.mjs",
  quiz: "src/quiz.mjs",
  watch: "src/watch.mjs",
};

function printHelp() {
  console.log(`
雨课堂学习助手（Agent 桥接）

用法:
  npm run agent -- <answer|course|quiz|watch> [底层脚本参数]

Agent 两段式答题:
  npm run agent -- quiz --agent-dump --open-url "<学习日志URL>" --todo --max-homeworks 1
  npm run agent -- quiz --answers-file "output/agent-answers.json" --open-url "<学习日志URL>" --todo

说明:
  - --agent-dump 只导出题目截图/结构，不请求模型、不填写。
  - --answers-file 读取 Agent 生成的 JSON 答案文件并回填。
  - --submit 只有在用户明确确认最终提交/交卷后才添加。
`);
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (!mode || mode === "-h" || mode === "--help") {
    printHelp();
    return;
  }
  const script = MODES[mode];
  if (!script) {
    console.error(`未知 Agent mode: ${mode}`);
    printHelp();
    process.exitCode = 1;
    return;
  }
  const child = spawn(process.execPath, [resolve(PROJECT_ROOT, script), ...rest], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    shell: false,
  });
  await new Promise((resolveExit) => {
    child.on("exit", (code, signal) => {
      process.exitCode = signal ? 1 : code ?? 0;
      resolveExit();
    });
  });
}

main().catch((e) => {
  console.error("agent bridge 运行失败:", e.message);
  process.exitCode = 1;
});
