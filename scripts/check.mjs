import { readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(
  process.argv[2] || fileURLToPath(new URL("..", import.meta.url)),
);
async function files(directory, match) {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? files(path, match)
        : match.test(entry.name)
          ? [path]
          : [];
    }),
  );
  return groups.flat();
}
let count = 0;
for (const directory of ["extensions", "shared", "web"]) {
  for (const path of await files(join(root, directory), /\.(?:js|mjs|ts)$/)) {
    const result = spawnSync(process.execPath, ["--check", path], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      process.stderr.write(result.stderr || String(result.error));
      process.exitCode = 1;
    }
    count++;
  }
}
if (!count) throw new Error("没有发现可检查的源文件");

// CSS 里 `//` 不是注释：解析器会连带丢弃紧随其后的整条规则（曾让 .view-panes 的高度
// 约束失效，很难在语法检查里发现），因此单独守住这一条。
let sheets = 0;
for (const path of await files(join(root, "web"), /\.css$/)) {
  const lines = (await readFile(path, "utf8")).split("\n");
  const index = lines.findIndex((line) => line.trimStart().startsWith("//"));
  if (index >= 0) {
    process.stderr.write(
      `${path}:${index + 1}: CSS 注释必须写成 /* */，行首的 // 会吃掉下一条规则\n`,
    );
    process.exitCode = 1;
  }
  sheets++;
}
if (!process.exitCode)
  console.log(`语法检查通过：${count} 个源文件、${sheets} 个样式表`);
