import { createFileService, workspaceError, EDIT_BYTES } from "./workspace-files.ts";
import { createGitService } from "./workspace-git.ts";

/** 独立工作区 RPC；不读取消息正文、不改变 Pi 会话树。 */
export function createWorkspaceService(snapshot) {
  let current, initialization, key, generation = 0;
  const subscriptions = new Map();
  async function context(input) {
    const state = snapshot();
    if (input.sessionId !== state.sessionId) throw workspaceError("会话已切换，请刷新工作面板", 409);
    const next = `${state.sessionId}:${state.cwd}`;
    if (next !== key) {
      generation++;
      current?.files.close(); current?.git.close();
      for (const item of subscriptions.values()) { clearTimeout(item.timer); item.res?.end(); }
      subscriptions.clear();
      key = next;
      const captured = generation;
      initialization = (async () => {
        const git = await createGitService(state.cwd);
        let files;
        try { files = await createFileService(state.cwd, git.repositoryRoot, git.ignoredPaths); }
        catch (error) { git.close(); throw error; }
        if (captured !== generation) { files.close(); git.close(); throw workspaceError("工作区已切换", 409); }
        current = { files, git }; return current;
      })().catch(error => { if (captured === generation) key = null; throw error; });
    }
    return initialization;
  }
  return {
    invalidateSession(sessionId) {
      if (key && !key.startsWith(`${sessionId}:`)) {
        generation++; current?.files.close(); current?.git.close();
        for (const entry of subscriptions.values()) { clearTimeout(entry.timer); entry.res?.end(); }
        subscriptions.clear(); key = null; current = null;
      }
    },
    async request(input) {
      if (!input || typeof input !== "object" || typeof input.op !== "string") throw workspaceError("工作区请求无效");
      const { files, git } = await context(input);
      if (input.op === "info") return { cwd: files.roots.cwd, repositoryRoot: git.repositoryRoot, roots: files.roots, workspaceId: files.workspaceId, limits: { editBytes: EDIT_BYTES }, capabilities: { files: true, git: Boolean(git.repositoryRoot), conflicts: true } };
      if (input.op === "watch") {
        if (!Array.isArray(input.targets) || input.targets.length > 64) throw workspaceError("监听目标无效");
        if (subscriptions.size >= 32) throw workspaceError("监听连接过多", 429);
        const entry = { res: null, timer: null };
        const subscription = files.subscribe(input.targets, event => entry.res?.write(`data: ${JSON.stringify(event)}\n\n`));
        await subscription.ready;
        entry.timer = setTimeout(() => { if (!entry.res) { files.unsubscribe(subscription.id); subscriptions.delete(subscription.id); } }, 30000);
        entry.timer.unref();
        subscriptions.set(subscription.id, entry);
        return { watchId: subscription.id };
      }
      if (input.op === "unwatch") { files.unsubscribe(input.watchId); const entry = subscriptions.get(input.watchId); clearTimeout(entry?.timer); entry?.res?.end(); subscriptions.delete(input.watchId); return { ok: true }; }
      if (input.op.startsWith("git_")) return git.request(input);
      return files.request(input);
    },
    async events(input, req, res) {
      const { files } = await context(input);
      const entry = subscriptions.get(input.watchId);
      if (!entry || entry.res) throw workspaceError("监听已过期或已连接", 409);
      clearTimeout(entry.timer);
      entry.res = res;
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" }); res.flushHeaders();
      res.write('data: {"type":"ready"}\n\n');
      const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000); heartbeat.unref();
      req.on("close", () => { clearInterval(heartbeat); files.unsubscribe(input.watchId); subscriptions.delete(input.watchId); });
    },
    close() { generation++; current?.files.close(); current?.git.close(); for (const entry of subscriptions.values()) { clearTimeout(entry.timer); entry.res?.end(); } subscriptions.clear(); },
  };
}
