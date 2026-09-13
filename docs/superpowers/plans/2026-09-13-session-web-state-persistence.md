# Session Web State Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist Web-only per-session metadata under `.pi/atom/<sessionId>/` and restore it after reload.

**Architecture:** A focused backend store owns validation, atomic JSON writes, debounce and lifecycle flushing. The bridge persists backend timings/display records and accepts a validated browser action for UI-derived timings and disclosure state.

**Tech Stack:** Node.js native TypeScript, Pi extension events, browser native ESM, Vue 3/Pinia, node:test.

**Spec:** `docs/superpowers/specs/2026-09-13-session-web-state-persistence-design.md`

## Global Constraints

- Project data lives at `./.pi/atom/<sessionId>/web-state.json`.
- Global settings are reserved for `~/.pi/atom/` and are not created in this change.
- Writes use a same-directory temporary file and atomic rename.
- No runtime credentials are persisted.

---

### Task 1: Persistent state store

**Files:** Create `extensions/session-state.ts`; create `test/session-state.test.js`.

**Interfaces:** Produce `createSessionStateStore({ cwd, sessionId, debounceMs })` with `load()`, `replace(value)`, `update(mutator)`, `flush()`, and `close()`.

- [ ] Write tests for canonical path, missing/corrupt input, bounded normalization and atomic flush.
- [ ] Run the focused test and confirm it fails because the module is absent.
- [ ] Implement the minimal store and normalization.
- [ ] Run the focused test and confirm it passes.

### Task 2: Protocol and bridge integration

**Files:** Modify `shared/protocol.ts`, `shared/protocol.js`, `extensions/index.ts`, `web/stores/conversation.js`, and conversation components; modify protocol and bridge tests.

**Interfaces:** Add `persistedUiState` to snapshots/patches and `save_ui_state` to actions.

- [ ] Add failing protocol and lifecycle restoration tests.
- [ ] Implement load/switch/flush handling, persisted tool/display data, and browser UI-state reporting.
- [ ] Run protocol, bridge, frontend and browser tests.

### Task 3: Documentation and complete verification

**Files:** Modify `AGENTS.md`, `README.md`, and `CHANGELOG.md`.

- [ ] Document storage boundaries, schema ownership and global-directory reservation.
- [ ] Run `npm run check`, `npm test`, `npm run test:browser`, and `git diff --check`.
