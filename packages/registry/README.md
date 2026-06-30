# @w6w/registry

Host-agnostic **App Registry** orchestrator. Owns the semantics (register / get / list / load /
lifecycle) over an injected [`DataStore`](../types/src/datastore.ts).

```ts
import { createRegistry, InMemoryAppDataStore } from "@w6w/registry";

const registry = createRegistry({ store: new InMemoryAppDataStore() });

const result = await registry.register("file:./fixtures/apps/hello");
// → { version: AppVersion, registered: true, latestAdvanced: true }

await registry.register("file:./fixtures/apps/hello");
// → { ..., registered: false }   ← idempotent, same content digest

const app = await registry.get("com.w6w.hello");
const { items } = await registry.list({ q: "hell" });

const loaded = await registry.load("com.w6w.hello");
//   → LoadedApp ready for @w6w/runtime.invoke / describe

await registry.setMaturity("com.w6w.hello", "deprecated");
await registry.setSuccessor("com.w6w.hello", "com.w6w.hello-next");
```

## What this module does (and doesn't)

- ✅ Orchestrates the register pipeline (`@w6w/sources` → `@w6w/runtime`).
- ✅ Computes the content `digest` for idempotency.
- ✅ Surfaces the registry contract (`Registry` interface) and lifecycle ops.
- ❌ No persistence. Bring a `DataStore` (Postgres, SQLite, in-memory).
- ❌ No HTTP / CLI. Wrap it.

## Exports

```ts
createRegistry, type CreateRegistryOptions, type Registry, type RegisterResult,
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
