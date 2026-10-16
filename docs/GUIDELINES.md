# Plugin development guidelines

These rules apply to the Tilr plugin set. Use them when adding a plugin or changing its
service contracts, saved state, resource lifetime or build. See the [plugin map](../../plugins/README.md)
for ownership boundaries and the [plugin SDK](plugin-sdk.md) for the shared build, configs and helpers.

## Responsibilities and dependencies

- State which service or window type the plugin provides and which resources it owns.
  A window that displays a remote process does not own that process by default.
- Declare required core services in `inject`, compatible core API in `api`, and required
  plugin versions in `requires`. Use scoped `ctx.inject` for optional integrations.
- If a fix depends on a new provider capability, raise the minimum required provider
  version. Keep legacy callers compatible where practical; document migrations explicitly.
- Keep public contracts in `src/api.ts` and import them as types. Ship `dist/api.d.ts`
  for service inspection. Runtime instances come from the host's service registry.

## Saved state and document safety

- Put window-specific durable state in window config, shared preferences in a store area,
  and secrets in secure areas. Validate restored JSON before using it.
- Save enough identity to reconstruct behavior: a document needs its server and path,
  not just text and a title. Do not depend on an in-memory map to restore save-back.
- Keep drafts dirty until the external write succeeds. An edit during a write must remain
  dirty; compare the saved snapshot before clearing the mark.
- Serialize related local operations. Save, rename and delete must agree on the document's
  destination. Update bindings for renamed folders and detach deleted documents.
- Detect external modifications before save-back. Document whether the check and write are
  atomic. A client-side read followed by a write cannot eliminate concurrent external edits.

## Resource lifetime and shared consumers

- Give every timer, listener, observer, subscription and decoded resource an owner and a
  cleanup path. Use context effects for plugin resources and mount cleanup for window resources.
- Count consumers or give them stable ids when sharing a subscription. Closing one window
  must not release another window's resource. Connection holds and pane subscriptions are
  separate responsibilities.
- Define who controls mutable shared settings, such as a pane's grid size, and how that
  responsibility transfers when a consumer leaves.
- After reconnect, obtain fresh authoritative state before restoring subscriptions. Reset
  requests whose answers cannot arrive over the new connection.
- Guard late async results after disposal. A closed window must not acquire a new resource
  or receive a delayed UI update.

## Failures and changes between services

- Handle rejected promises from UI actions and initialization. Keep gesture-sensitive work
  inside the original input handler; returning a promise does not extend the gesture.
- Show actionable startup and operation failures near the affected content. Console logs
  are useful diagnostics but should not be the only indication of a failed save.
- Distinguish explicit protocol/authentication refusal from temporary unavailability.
  Bound connection attempts, back off retries, and cancel timers on manual stop and disposal.
- Notify consumers when connection credentials change, even when profile fields do not.
  Events should identify the resource without exposing secrets.

## Build and code organization

- Share the host's `tilr` and `cordis` runtime. Share host React when using its React API;
  isolate third-party widgets that deliberately carry their own runtime.
- Keep generated output in `dist/`. Compile before installing; preserve the last good
  installed build after a compilation failure. Type checking is a separate required check.
- A window whose content is not DOM (canvas, WebGL, a native view, a painted grid) gives
  agents `agent.text` on its window type, and `agent.input` if it takes input (a trailing
  newline is Enter); otherwise the a11y panel flags it blind. See README, What the agent sees.
- Extract cohesive modules when rendering, input, protocol and document logic become hard
  to follow in one entry file. Pure logic should be testable without mounting the UI.
- Build with the SDK's `buildPlugin()` ([plugin SDK](plugin-sdk.md)); a fix to common build
  behavior belongs there, not in a plugin's build.mjs. Plugin-specific assets and transforms
  stay explicit options or hooks (`esbuild`, `copy`, `hooks.after`).

## Update isolation and performance

- Subscribe to the entity and fields actually displayed. In SDK 0.1.13, use
  `win.subscribe(draw, ['title', 'focused'])`, `useWindow(['mode'])` or
  `useWindowField('title')`. Omitting fields preserves the global legacy subscription.
  Older providers may broadcast; keep snapshot equality guards and require API ^0.1.13
  when importing the new hook. Replace configs instead of mutating them in place.
- Keep React renders and DOM drawing free of state reconciliation. Retain stable keys,
  action nodes and snapshot identities; do not use mutable objects as memoization guards.
- Apply ordered protocol deltas to state, then coalesce dirty visual regions into one
  animation-frame job. Do not discard deltas or delay input handling to reduce render counts.
- Pause visual-only timers and drawing for hidden windows, including inactive tabs;
  resume from current state. Preserve required protocol, background and persistence work.
- Bound caches and queues and release graphics/async resources after close or reload.
- Use the existing opt-in Performance collector. Guard timing and payload allocation with
  `collecting()`; no plugin-owned telemetry timer should survive disabled collection.
- Test update isolation: a title change must not cause unrelated rendering, geometry work
  or remounting. Also cover equal writes, hidden/reveal, burst updates and repeated disposal.
  Measure CPU and latency with the same workload and profiling build, not a universal
  renders-per-second threshold.

The SDK audit, proposed shared contract and migration gates live in
[Plugin performance and update isolation](../PERFORMANCE.md) in the Tilr workspace.
The guide distinguishes implemented field selection from the proposed scheduler and
remaining migrations; not every isolation gate is enforced today.

## Verification and documentation

- Add a regression test for the failure being fixed. Prefer observable behavior: preserved
  drafts, correct write destinations, continued frames and recovered connections.
- Cover multiple consumers, reload, disposal, missing optional providers, external changes
  and delayed responses when those scenarios affect the change.
- Run TypeScript and oxlint (`npm run check`), the applicable unit tests, a build and relevant E2E tests.
  Build local providers and the core before integration tests that consume their output.
- Verify native-only behavior in the app. An iframe test does not validate native proxy
  routing or cookie isolation. Report test-environment failures separately from assertions.
- Keep package and lockfile versions consistent. Update README and changelog with changed
  behavior, minimum dependencies, recovery paths and material limitations.

These are development rules; the current plugin set may still have gaps. In particular,
atomic conflict prevention needs server support, and save-back errors without a Files
window currently use console reporting.
