import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("recursive checker catches invalid nested browser modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "atom-check-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    for (const directory of ["web/components", "shared", "extensions"])
      await mkdir(join(root, directory), { recursive: true });
    await writeFile(
      join(root, "web/components/Broken.js"),
      "export const broken = ;",
    );
    const result = spawnSync(process.execPath, ["scripts/check.mjs", root], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Broken\.js/);
    await writeFile(
      join(root, "web/components/Broken.js"),
      "export const fixed = 1;",
    );
    const fixed = spawnSync(process.execPath, ["scripts/check.mjs", root], {
      encoding: "utf8",
    });
    assert.equal(fixed.status, 0, fixed.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
