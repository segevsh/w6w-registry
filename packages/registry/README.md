# @w6w/registry

Host-agnostic **App Registry** orchestrator. Owns the semantics (register / registerPack / refresh /
get / list / load / lifecycle) over an injected [`DataStore`](../types/src/datastore.ts).

```ts
import { createRegistry, InMemoryAppDataStore } from "@w6w/registry";

const registry = createRegistry({ store: new InMemoryAppDataStore() });

const result = await registry.register("file:./fixtures/apps/hello");
// → { version: AppVersion, registered: true, latestAdvanced: true }

await registry.register("file:./fixtures/apps/hello");
// → { ..., registered: false }   ← idempotent, same content digest

const app = await registry.get("io.w6w.hello");
const { items } = await registry.list({ q: "hell" });

const loaded = await registry.load("io.w6w.hello");
//   → LoadedApp ready for @w6w/runtime.invoke / describe

await registry.setMaturity("io.w6w.hello", "deprecated");
await registry.setSuccessor("io.w6w.hello", "io.w6w.hello-next");
```

## What this module does (and doesn't)

- ✅ Orchestrates the register pipeline (`@w6w/sources` → `@w6w/runtime`).
- ✅ Computes the content `digest` for idempotency.
- ✅ Surfaces the registry contract (`Registry` interface) and lifecycle ops.
- ✅ Multi-app install via **Pack** manifests (`w6w-pack.json`).
- ✅ In-place refresh with auto-bump on content-with-same-version collisions.
- ❌ No persistence. Bring a `DataStore` (Postgres, SQLite, in-memory).
- ❌ No HTTP / CLI. Wrap it.

## Refresh — re-resolve stored source

`refresh(id, opts?)` re-loads the app from its recorded `sourceRef` and rewrites
the registry when the content changed. Handles the common dev-loop of "I edited
an asset in place, please just pick it up."

```ts
await registry.refresh("io.w6w.hello");
// → { registered, latestAdvanced, bumped, sourceVersion, version }
```

- Digest matches stored latest → no-op (`registered: false, bumped: false`).
- Source manifest version > stored latest → written as a new version.
- Source manifest version equals stored latest, but content differs → the
  stored version is **auto-bumped** by `opts.versionBump` (default `"patch"`)
  and written. The source file on disk is not modified.
- Source manifest version < stored latest → `RegistryError("version_conflict")`.

## Packs — install many apps at once

A **Pack** is a directory (or a git repo) whose root holds a `w6w-pack.json`
file listing paths to individual App directories. The registry can install every
entry in one call.

```jsonc
// w6w-pack.json — at the root of a pack repo
{
  "manifestVersion": "1",
  "kind": "pack",
  "name": "w6w-official",
  "displayName": "w6w Official Apps",
  "version": "0.1.0",
  "apps": [
    { "path": "./slack" },
    { "path": "./notion", "version": "0.2.1" },
    { "path": "./legacy-thing", "optional": true }
  ]
}
```

Install:

```ts
const packResult = await registry.registerPack("github:w6w-io/w6w-apps@main");
// → { pack, results, registered, failed }
//   results[i] is { path, ok:true, result } | { path, ok:false, error, optional? }
```

- Per-entry failures are captured, not thrown — the whole pack still tries every
  entry.
- Optional per-entry `id` / `version` pins: mismatches surface as
  `manifest_id_mismatch` / `manifest_version_mismatch` on that entry only.
- `optional: true` marks an entry whose failure a caller may choose to ignore
  (the failure is still counted in `failed`, just flagged).

Detection is a cheap stat — `isPackDir(dir)` looks for `w6w-pack.json`. A host
that wants a single import endpoint can peek the resolved dir and dispatch:

```ts
import { isPackDir, readPackManifest } from "@w6w/registry";

const dir = await resolve(sourceRef);
if (await isPackDir(dir)) {
  return await registry.registerPack(sourceRef); // multi-app
}
return await registry.register(sourceRef);       // single app
```

## Exports

```ts
createRegistry, type CreateRegistryOptions, type Registry,
type RegisterResult, type RefreshResult, type RefreshOptions,
type PackRegisterResult, type PackEntryResult,
isPackDir, readPackManifest,
canonicalJson, digestDescription,
InMemoryAppDataStore,

// re-exported from @w6w/registry-types for one-import convenience:
type AppVersion, type RegisteredApp, type LifecycleOverlay,
type EffectiveClassification, type Origin,
type DataStore, type ListQuery, type Page, type Cursor,
type PutVersionInput, type PutVersionResult,
effectiveClassification, RegistryError
```

## Tests

```sh
deno task test
```
