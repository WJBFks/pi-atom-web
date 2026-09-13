import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const files = (await readdir(new URL("../test/", import.meta.url)))
  .filter((name) => name.endsWith(".test.js") || name.endsWith(".test.ts"))
  .sort()
  .map((name) => `test/${name}`);
if (!files.length) throw new Error("没有发现测试，拒绝报告成功");
const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
