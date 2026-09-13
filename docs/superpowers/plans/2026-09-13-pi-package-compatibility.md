# Pi Package Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lazy, package-scoped backend and Web compatibility and fully support @juicesharp/rpiv-ask-user-question 2.9.0.

**Architecture:** A backend registry activates a compatibility module only after the package's public event is observed. Structured requests carry packageId, and a browser registry dynamically imports the matching Vue UI only when such a request exists.

**Tech Stack:** Pi Extension TypeScript, Node.js native HTTP, Vue 3 native ESM, Pinia, SSE, Playwright.

**Spec:** docs/superpowers/specs/2026-09-13-pi-package-compatibility-design.md

## Global Constraints

- No frontend build step, SFC, JSX, external CDN, or untrusted HTML.
- Missing packages remain silent and do not activate compatibility code.
- The generic dialog bridge must contain no rpiv questionnaire business rules.
- Existing unrelated dirty-worktree changes must be preserved.
- Verification commands are `npm run check`, `npm test`, and `npm run test:browser`.

---

### Task 1: Backend compatibility registry and rpiv adapter

**Files:**
- Create: `extensions/packages/registry.ts`
- Create: `extensions/packages/@juicesharp/rpiv-ask-user-question/index.ts`
- Create: `extensions/packages/@juicesharp/rpiv-ask-user-question/adapter.ts`
- Create: `extensions/packages/@juicesharp/rpiv-ask-user-question/result.ts`
- Modify: `extensions/index.ts`
- Modify: `extensions/dialogs.ts`
- Delete: `extensions/ask-user.ts`
- Test: `test/bridge.test.js`

**Interfaces:**
- Produces: `createPackageCompatibilityRegistry(pi)` with `start(event)`, `end(toolCallId)`, `takeCustom(factory)`, and `clear()`.
- Produces: claimed request objects with `packageId`, `kind`, `payload`, and `buildResult(value, cancel)`.

- [ ] Add failing tests for silent inactive state, event-driven activation, ambiguous-call rejection, and 2.9.0 results including globalNote.
- [ ] Run `node --test test/bridge.test.js` and confirm the new assertions fail on missing registry modules.
- [ ] Implement the registry, adapter, result builder, and generic dialog claim contract.
- [ ] Migrate index lifecycle wiring and remove the old top-level adapter.
- [ ] Run `node --test test/bridge.test.js` and confirm it passes.

### Task 2: Shared request protocol

**Files:**
- Modify: `shared/protocol.js`
- Modify: `shared/protocol.ts`
- Test: `test/protocol.test.js`

**Interfaces:**
- Consumes: package request fields `packageId`, `kind`, and structured payload.
- Produces: bounded validated dialog requests and responses containing global notes.

- [ ] Add failing protocol tests for valid rpiv requests, globalNote payloads, unknown package fallback, and malformed bounds.
- [ ] Run `node --test test/protocol.test.js` and confirm failure.
- [ ] Add matching validators to both reload-safe protocol files.
- [ ] Run `node --test test/protocol.test.js` and confirm success.

### Task 3: Lazy Web registry and complete questionnaire UI

**Files:**
- Create: `web/packages/registry.js`
- Create: `web/packages/@juicesharp/rpiv-ask-user-question/index.js`
- Move: `web/components/dialogs/AskUserForm.js` to the package directory
- Move: `web/components/dialogs/answers.js` to the package directory
- Create: `web/packages/@juicesharp/rpiv-ask-user-question/style.css`
- Modify: `web/components/dialogs/RequestDock.js`
- Modify: `extensions/server.ts`
- Modify: `web/style.css`
- Test: `test/answers.test.js`
- Test: `test/frontend.test.js`
- Test: `test/browser/web.spec.js`

**Interfaces:**
- Produces: `packageRequestComponent(packageId)`, returning a cached Vue async component or null.
- Component props: `request`, `pending`; emit `submit` with `{id,draft,globalNote,cancel}`.

- [ ] Add failing unit/browser assertions for on-demand module loading, single/multi/custom answers, preview, notes, global note, partial submit, cancel, collapse, and draft restoration.
- [ ] Run the focused tests and confirm the new assertions fail.
- [ ] Implement the dynamic Web registry and migrate all questionnaire files and styles.
- [ ] Update RequestDock to dispatch package requests without importing package-specific UI eagerly.
- [ ] Expose package JS/CSS through the existing recursive static whitelist.
- [ ] Run focused unit and browser tests and confirm success.

### Task 4: Documentation and complete verification

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] Document both package roots, lazy activation, silent missing-package behavior, and complete 2.9.0 coverage.
- [ ] Remove stale 2.6.2 and old path references.
- [ ] Run `npm run check`.
- [ ] Run `npm test`.
- [ ] Run `npm run test:browser`.
- [ ] Inspect the final diff for accidental changes to concurrent work.

