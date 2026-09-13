---
name: pi-package-compatibility
description: Use when adding, migrating, or reviewing compatibility for a Pi third-party package in pi-atom-web, including backend adapters, package-specific protocol payloads, Web UI components, or lazy activation behavior.
---

# Pi Package Compatibility

Keep third-party package knowledge at the edge of pi-atom-web. Core extension and Web modules provide generic transport and lifecycle hooks; each package compatibility module translates between that package and those hooks.

## Directory ownership

Mirror the npm package name under both compatibility roots:

```text
extensions/packages/<scope>/<package>/
web/packages/<scope>/<package>/
```

Create only the side a package needs. A backend-only package has no Web directory; a purely presentational compatibility may have no backend directory.

Keep registries at:

- `extensions/packages/registry.ts`
- `web/packages/registry.js`

A package directory owns all knowledge specific to that package: event names, tool names, factory recognition, request payloads, result construction, Vue components, browser state keys, copy, and CSS selectors. Generic modules such as `extensions/dialogs.ts`, `web/components/dialogs/RequestDock.js`, stores, and global `web/style.css` must not contain package names or package-specific branches.

## Activation philosophy

Treat observed capability as proof of availability. Prefer a package's stable public event or API over scanning global installation directories or importing private files.

Backend activation follows this order:

1. Observe only lightweight generic lifecycle data needed to correlate a future capability event.
2. When the package's unique public event is observed, dynamically import its local compatibility module.
3. Replay any bounded candidate data into the activated adapter.
4. Keep missing, unused, incompatible, or failed optional compatibility silent: no UI notification, warning, or service failure.

Do not eagerly import every compatibility module at extension startup. A matching tool name alone may be shared by another package; require a package-specific public capability signal before allowing the adapter to claim UI.

Web activation starts later. Put `packageId` on a validated backend request, and dynamically import the matching Web module only when that request actually exists. Package CSS belongs beside the component and loads from that module. Do not add package CSS to `web/style.css` or eagerly import package components from `RequestDock.js`.

Absence must be inert:

- no package module execution
- no browser module or CSS request
- no warning, error, or notification
- no change to generic dialog behavior

## Backend contract

A backend compatibility adapter may claim a generic `ui.custom()` factory. A successful claim provides:

```ts
{
  packageId: string;
  request: {
    kind: string;
    // bounded, JSON-safe package payload
  };
  buildResult(value: unknown, cancel: boolean): unknown;
}
```

The dialog bridge adds its own request ID, session ID, and generic lifecycle fields. It passes a Web response to `buildResult` and returns the result through the original package's `done` callback. The bridge must not construct package result fields itself.

Reject ambiguous correlations rather than sharing an answer between concurrent calls. Clear candidates on tool completion, session change, reload, and shutdown. The first completed TUI or Web response wins; late responses must fail as stale.

Use public package contracts. Do not import a package's internal source paths or execute its TUI component in the browser. If a public event omits large data such as previews, correlate it with the original bounded tool arguments and verify there is exactly one match.

## Web contract

`web/packages/registry.js` maps a package ID to a dynamic import and returns a cached async Vue component. Unknown IDs return no specialized component and fall back to the generic request UI.

A package Web entry module owns:

- its Vue component tree
- package-specific draft persistence and cleanup
- package-specific CSS loading
- translation between form state and the backend response value

Use ordinary browser ESM, Vue 3 Composition API, and render functions. Continue to follow the `pi-vue-nobuild` skill: no SFC, JSX, bundler, generated frontend artifact, or external CDN.

Render ordinary text as text VNodes. Reuse the project's sanitized Markdown component for package Markdown. Keep draft state in sessionStorage only when it belongs to the current browser tab; remove it when the request ends.

## Protocol and security

Every package request crosses the shared protocol boundary. Validate:

- `packageId`, request ID, session ID, kind, and tool call ID
- array counts and text lengths from the public package schema
- nested JSON shape and total serialized size
- every browser response before invoking `buildResult`

Keep `shared/protocol.js` and `shared/protocol.ts` byte-identical. Serve dynamic JS and CSS through the server's explicit recursive Web asset map. Never turn package IDs or request data into filesystem paths.

Unknown or unsupported package requests use the generic fallback. A broken optional compatibility module must not disconnect SSE or prevent unrelated dialogs from working.

## Change workflow

Before implementing:

1. Inspect the installed package's public exports, event contract, schema, result envelope, version, and user-visible functions.
2. List which capabilities require backend translation, Web UI, or both.
3. Define the package claim and bounded request/response shape.
4. Confirm that no package-specific code is needed in generic modules beyond registry dispatch.

During implementation, move existing compatibility rather than leaving duplicate entry points. Search outside both package directories for package names, tool names, storage prefixes, and CSS selectors; remaining occurrences should be tests, documentation, or genuinely generic registry metadata.

Verify at minimum:

- missing package/capability stays inactive and silent
- public capability event activates exactly one adapter
- concurrent or ambiguous calls are not claimed
- result construction matches the installed public contract
- the Web module and CSS are absent before a matching request
- specialized UI loads after a matching request
- unknown package requests retain the generic fallback
- package completion clears drafts and resources
- generic select, confirm, input, custom terminal, SSE, and reload still work
- `npm run check`, `npm test`, and `npm run test:browser` pass

Update `AGENTS.md`, `README.md`, and `CHANGELOG.md` when compatibility architecture or supported package behavior changes.

