---
name: pi-vue-nobuild
description: Enforce the no-build Vue 3 architecture for the pi-atom-web Pi extension. Use when adding, reviewing, or restructuring its browser UI, state, routing, realtime transport, or frontend dependencies.
---

# Pi Vue No-Build Architecture

Keep this project directly executable by Node.js and modern browsers without a frontend build step.

## Architecture

- Pi extension code uses TypeScript supported directly by the host runtime.
- The server uses Node.js native `http`.
- The browser UI uses Vue 3, Pinia, Vue Router, and native browser ES modules.
- Prefer SSE for server-to-client streaming. Use WebSocket only when the feature truly needs bidirectional realtime traffic.

## Hard constraints

Do not introduce:

- Vite, Webpack, Rollup, Parcel, esbuild, or another frontend bundler
- frontend transpilation or generated build artifacts
- Vue SFC files (`.vue`), `<script setup>`, JSX, or TSX
- React or Nuxt
- dependencies whose browser use requires bundling

Frontend source files must remain directly executable by modern browsers. Serve third-party browser modules locally through the existing Node HTTP server; do not add an external CDN dependency.

## Vue

Use Vue 3 Composition API where it improves ownership and cleanup. Write components as ordinary JavaScript modules with `defineComponent()` and `setup()`, or equivalent Composition API patterns. Import from browser-resolvable local module paths configured by this project; a bare import such as `from 'vue'` is acceptable only when the server provides an import map or equivalent native-browser resolution.

## State

Use Pinia for application-wide state. Keep local UI state in components when it has no cross-component owner. Isolate high-frequency streaming state so token-by-token updates do not invalidate the full transcript or unrelated controls.

## Router and lifecycle

Use Vue Router for page-level navigation. Every route or component that creates resources must dispose them on exit or unmount, including:

- `EventSource` and WebSocket connections
- timers
- DOM listeners
- `AbortController` instances
- Vue watchers and effect scopes created outside normal component ownership

## Realtime checklist

Implement connection state, error handling, disconnect cleanup, and bounded reconnect behavior. Add heartbeat handling when idle intermediaries can silently drop a connection. Avoid reconnect loops and duplicate active streams.

## Dependency order

Prefer, in order:

1. Browser-native APIs
2. Vue ecosystem packages that ship browser-executable ESM
3. Small dependency-free libraries

Before adding a dependency, verify its distributed files can be served and imported without compilation or bundling.

## Change review

For every frontend change, confirm:

- no build script or bundler configuration was added
- browser imports resolve from files served by `extensions/server.ts`
- realtime resources are cleaned up
- streaming updates remain localized
- existing `npm run check`, tests, and direct browser loading still work
