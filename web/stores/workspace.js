import { defineStore } from "pinia";
import { workspaceRequest, openWorkspaceEvents } from "../api/workspace.js";

const watches = new WeakMap(), flights = new WeakMap(), requests = new WeakMap();
export const useWorkspaceStore = defineStore("workspace", {
  state: () => ({ token: "", sessionId: null, active: false, info: null, root: "cwd", tree: [], git: null, revision: null, watchId: null, watchTargets: [], invalidatedTargets: [], invalidateCount: 0, generation: 0, watchGeneration: 0 }),
  actions: {
    configure(token, sessionId) {
      if (this.sessionId !== sessionId || this.token !== token) {
        this.close(); this.generation++; this.info = null; this.git = null; this.tree = []; this.root = "cwd"; this.watchTargets = [];
      }
      this.token = token || ""; this.sessionId = sessionId || null;
    },
    async request(op, params) {
      const captured = this.generation, controller = new AbortController();
      if (!requests.has(this)) requests.set(this, new Set());
      requests.get(this).add(controller);
      try {
        const result = await workspaceRequest(this.token, this.sessionId, op, params, fetch, controller.signal);
        if (captured !== this.generation) throw new DOMException("工作区已切换", "AbortError");
        return result;
      } finally { requests.get(this)?.delete(controller); }
    },
    async open() {
      this.active = true;
      if (!this.info) this.info = await this.request("info");
      if (!this.watchId) this.startWatch().catch(() => {});
    },
    close() {
      this.active = false; this.stopWatch(); this.generation++;
      for (const controller of requests.get(this) || []) controller.abort();
      requests.delete(this); flights.delete(this);
    },
    async refreshGit() {
      if (!this.active || document.visibilityState !== "visible") return null;
      if (flights.has(this)) return flights.get(this);
      const task = this.request("git_status").then(result => { this.git = result; this.revision = result.revision; return result; }).finally(() => { if (flights.get(this) === task) flights.delete(this); });
      flights.set(this, task); return task;
    },
    async startWatch() {
      this.stopWatch();
      if (!this.active || document.visibilityState !== "visible") return;
      const captured = this.watchGeneration, token = this.token, sessionId = this.sessionId;
      const targets = this.watchTargets.length ? this.watchTargets : [{ root: this.root, path: "" }];
      const { watchId } = await this.request("watch", { targets: targets.slice(0,64) });
      if (!this.active || captured !== this.watchGeneration) { workspaceRequest(token, sessionId, "unwatch", { watchId }).catch(() => {}); return; }
      this.watchId = watchId;
      const controller = new AbortController(); watches.set(this, controller);
      openWorkspaceEvents(token, sessionId, watchId, event => { if (event?.type === "invalidate") { this.invalidatedTargets = event.targets || []; this.invalidateCount++; } }, controller.signal)
        .finally(() => { if (this.watchId === watchId) { this.watchId = null; this.invalidateCount++; } }).catch(() => {});
    },
    stopWatch() {
      this.watchGeneration++;
      watches.get(this)?.abort(); watches.delete(this);
      const watchId = this.watchId; this.watchId = null;
      if (watchId) workspaceRequest(this.token, this.sessionId, "unwatch", { watchId }).catch(() => {});
    },
    setWatchTargets(targets) { this.watchTargets = targets; if (this.active) this.startWatch().catch(() => {}); },
  },
});
