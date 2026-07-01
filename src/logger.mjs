// 运行日志：累计每题记录，写 JSON 到 output/，并打印可读的控制台行。

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export function createLogger(outDirAbs) {
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const records = [];

  const truncate = (s, n = 100) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  };

  return {
    logQuestion(rec) {
      records.push(rec);
      const ans = rec.answer && rec.answer.length ? rec.answer.join("") : "-";
      const status = rec.error
        ? `✗ ${rec.error}`
        : rec.inspectOnly
          ? "仅检查"
        : rec.skipped
          ? "已答·跳过"
          : rec.submitInfo
            ? `✓${rec.submitInfo}`
            : rec.clicked
              ? "✓已选"
              : rec.dryRun
                ? "（dry-run未点）"
                : "未点";
      console.log(
        `  [${rec.index}] ${rec.type || "?"} 答案=${ans} ${status} | ${truncate(rec.stem, 60)}`,
      );
      if (rec.reason) console.log(`       理由: ${truncate(rec.reason, 80)}`);
    },
    note(msg) {
      console.log(msg);
    },
    async save() {
      await mkdir(outDirAbs, { recursive: true });
      const path = resolve(outDirAbs, `run-${stamp}.json`);
      await writeFile(
        path,
        JSON.stringify(
          {
            startedAt: startedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            total: records.length,
            answered: records.filter((r) => r.clicked).length,
            submitted: records.filter((r) => r.submitted).length,
            failed: records.filter((r) => r.error).length,
            records,
          },
          null,
          2,
        ),
        "utf8",
      );
      return path;
    },
    summary() {
      const total = records.length;
      const clicked = records.filter((r) => r.clicked).length;
      const submitted = records.filter((r) => r.submitted).length;
      const failed = records.filter((r) => r.error).length;
      return { total, clicked, submitted, failed };
    },
  };
}
