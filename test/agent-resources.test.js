import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentResources,
  findContextFiles,
} from "../extensions/agent-resources.ts";

async function makeTree() {
  const root = await mkdtemp(join(tmpdir(), "atom-res-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "proj", "sub");
  const agent = (p) => join(agentDir, p);
  const proj = (p) => join(cwd, p);

  // 全局：两个扩展（一个目录、一个裸文件）+ settings 声明的额外扩展
  await mkdir(agent("extensions/dir-ext"), { recursive: true });
  await writeFile(agent("extensions/dir-ext/index.ts"), "export default () => {}");
  await writeFile(agent("extensions/loose.ts"), "export default () => {}");
  await mkdir(agent("standalone"), { recursive: true });
  await writeFile(agent("standalone/extra.ts"), "export default () => {}");
  // 全局 settings.json：声明两个包（一个带版本号、一个 scoped 无版本）与额外扩展路径
  await writeFile(
    agent("settings.json"),
    JSON.stringify({
      packages: ["npm:pkg-a", "npm:@scope/pkg-b@2.0.0"],
      extensions: ["standalone/extra.ts"],
    }),
  );
  // npm 包：manifest 声明 extensions 与 约定目录 extensions/ 两种形态
  const pkgA = agent("npm/node_modules/pkg-a");
  await mkdir(pkgA, { recursive: true });
  await writeFile(join(pkgA, "package.json"), JSON.stringify({ name: "pkg-a", pi: { extensions: ["./ext.ts"] } }));
  await writeFile(join(pkgA, "ext.ts"), "export default () => {}");
  const pkgB = agent("npm/node_modules/@scope/pkg-b");
  await mkdir(join(pkgB, "extensions"), { recursive: true });
  await writeFile(join(pkgB, "package.json"), JSON.stringify({ name: "@scope/pkg-b" }));
  await writeFile(join(pkgB, "extensions", "b.ts"), "export default () => {}");
  // 与 pi 无关的依赖包（无 pi manifest、无 extensions 目录）不应被列出
  const dep = agent("npm/node_modules/some-dep");
  await mkdir(dep, { recursive: true });
  await writeFile(join(dep, "package.json"), JSON.stringify({ name: "some-dep" }));

  // 项目级
  await mkdir(proj(".pi/extensions"), { recursive: true });
  await writeFile(proj(".pi/extensions/proj-ext.ts"), "export default () => {}");
  await writeFile(proj(".pi/settings.json"), JSON.stringify({ packages: ["npm:proj-pkg"] }));
  const projPkg = proj(".pi/npm/node_modules/proj-pkg");
  await mkdir(join(projPkg, "extensions"), { recursive: true });
  await writeFile(join(projPkg, "package.json"), JSON.stringify({ name: "proj-pkg" }));
  await writeFile(join(projPkg, "extensions", "pp.ts"), "export default () => {}");

  // 上下文文件：中间层 AGENTS.md、当前目录 CLAUDE.md（全局 agent 目录无上下文文件）
  await writeFile(join(root, "proj", "AGENTS.md"), "parent");
  await writeFile(proj("CLAUDE.md"), "current");
  // 系统提示：项目 SYSTEM.md 优先于全局；APPEND 只有全局
  await writeFile(agent("APPEND_SYSTEM.md"), "append");
  await writeFile(proj(".pi/SYSTEM.md"), "proj sys");

  return { root, agentDir, cwd };
}

const COMMANDS = [
  { name: "skill:zeta", description: "skill zeta", source: "skill", sourceInfo: { path: "/skills/zeta/SKILL.md", source: "global", scope: "user", origin: "top-level" } },
  { name: "skill:alpha", description: "skill alpha (pkg)", source: "skill", sourceInfo: { path: "/pkg/SKILL.md", source: "npm:pkg-a", scope: "user", origin: "package" } },
  { name: "commit", description: "commit prompt", source: "prompt", sourceInfo: { path: "/prompts/commit.md", source: "global", scope: "user", origin: "top-level" } },
  { name: "web", description: "web command", source: "extension", sourceInfo: { path: "/ext/index.ts", source: "global", scope: "user", origin: "top-level" } },
  { name: "web-wlan", description: "wlan", source: "extension", sourceInfo: {} },
];

test("buildAgentResources 汇总技能/模板（来自 getCommands，按名排序、剥离 skill: 前缀）", async () => {
  const t = await makeTree();
  try {
    const res = buildAgentResources({ cwd: t.cwd, isProjectTrusted: true, agentDir: t.agentDir, getCommands: () => COMMANDS });
    assert.deepEqual(
      res.skills.map((s) => s.name),
      ["alpha", "zeta"],
    );
    const pkg = res.skills.find((s) => s.name === "alpha");
    assert.equal(pkg.source, "package");
    assert.equal(pkg.sourceName, "npm:pkg-a");
    assert.equal(res.skills.find((s) => s.name === "zeta").source, "global");
    assert.deepEqual(
      res.prompts.map((p) => p.name),
      ["commit"],
    );
  } finally {
    await rm(t.root, { recursive: true, force: true });
  }
});

test("buildAgentResources 扩展列表覆盖全局/项目/包，包扩展以包名展示", async () => {
  const t = await makeTree();
  try {
    const res = buildAgentResources({ cwd: t.cwd, isProjectTrusted: true, agentDir: t.agentDir, getCommands: () => [] });
    const names = res.extensions.map((e) => e.name);
    assert.equal(names.length, 7);
    assert.deepEqual(
      new Set(names),
      new Set(["dir-ext", "loose", "extra", "proj-ext", "pkg-a", "@scope/pkg-b", "proj-pkg"]),
    );
    const by = (n) => res.extensions.find((e) => e.name === n);
    assert.equal(by("extra").source, "global");
    assert.equal(by("proj-ext").source, "project");
    assert.equal(by("pkg-a").source, "package");
    assert.equal(by("pkg-a").sourceName, "pkg-a");
    assert.equal(by("@scope/pkg-b").sourceName, "@scope/pkg-b");
    assert.ok(by("pkg-a").path.endsWith(join("pkg-a", "ext.ts")));
    assert.ok(by("proj-pkg").path.endsWith(join("proj-pkg", "extensions", "pp.ts")));
  } finally {
    await rm(t.root, { recursive: true, force: true });
  }
});

test("项目未受信时不列出项目级扩展与项目包，全局资源不受影响", async () => {
  const t = await makeTree();
  try {
    const res = buildAgentResources({ cwd: t.cwd, isProjectTrusted: false, agentDir: t.agentDir, getCommands: () => [] });
    const names = res.extensions.map((e) => e.name);
    assert.equal(names.length, 5); // 项目扩展与项目包不列出
    assert.ok(!names.includes("proj-ext"));
    assert.ok(!names.includes("proj-pkg"));
    assert.ok(names.includes("loose"));
    assert.ok(!res.definition.packages.includes("npm:proj-pkg"));
    assert.ok(res.definition.packages.includes("npm:pkg-a"));
    assert.equal(res.definition.projectTrusted, false);
  } finally {
    await rm(t.root, { recursive: true, force: true });
  }
});

test("findContextFiles 按父目录→当前目录顺序解析候选文件（无全局文件时）", async () => {
  const t = await makeTree();
  try {
    const files = findContextFiles(t.cwd, t.agentDir);
    assert.deepEqual(
      files.map((f) => f.path),
      [
        join(t.root, "proj", "AGENTS.md"),
        join(t.cwd, "CLAUDE.md"),
      ],
    );
    assert.ok(files[0].size > 0);
  } finally {
    await rm(t.root, { recursive: true, force: true });
  }
});

test("定义：SYSTEM.md 项目优先、APPEND 回退全局、settings 存在性与 packages 合并", async () => {
  const t = await makeTree();
  try {
    const res = buildAgentResources({ cwd: t.cwd, isProjectTrusted: true, agentDir: t.agentDir, getCommands: () => [] });
    assert.equal(res.definition.systemPromptFile, join(t.cwd, ".pi", "SYSTEM.md"));
    assert.equal(res.definition.appendSystemPromptFile, join(t.agentDir, "APPEND_SYSTEM.md"));
    const settings = res.definition.settings;
    assert.equal(settings[0].exists, true);
    assert.equal(settings[1].exists, true);
    assert.deepEqual(res.definition.packages, ["npm:pkg-a", "npm:@scope/pkg-b@2.0.0", "npm:proj-pkg"]);
  } finally {
    await rm(t.root, { recursive: true, force: true });
  }
});

test("getCommands 抛错时降级为空列表，不中断快照构建", async () => {
  const t = await makeTree();
  try {
    const res = buildAgentResources({
      cwd: t.cwd,
      isProjectTrusted: true,
      agentDir: t.agentDir,
      getCommands: () => {
        throw new Error("runtime not ready");
      },
    });
    assert.deepEqual(res.skills, []);
    assert.deepEqual(res.prompts, []);
    assert.ok(res.extensions.length > 0);
  } finally {
    await rm(t.root, { recursive: true, force: true });
  }
});
