import { readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(
  process.argv[2] || fileURLToPath(new URL("..", import.meta.url)),
);
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? files(path)
        : /\.(?:js|mjs|ts)$/.test(entry.name)
          ? [path]
          : [];
    }),
  );
  return groups.flat();
}
let count = 0;
for (const directory of ["extensions", "shared", "web"]) {
  for (const path of await files(join(root, directory))) {
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
if (!process.exitCode) console.log(`语法检查通过：${count} 个源文件`);
