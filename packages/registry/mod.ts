/**
 * @w6w/registry — host-agnostic App Registry orchestrator.
 *
 * ```ts
 * import { createRegistry } from "@w6w/registry";
 * import { PostgresAppDataStore } from "@w6w/server-db";
 *
 * const registry = createRegistry({ store: new PostgresAppDataStore(db) });
 * await registry.register("file:./apps/hello");
 * const apps = await registry.list({});
 * const loaded = await registry.load("com.w6w.hello"); // ready for runtime.invoke
 * ```
 *
 * Takes a `DataStore` (from `@w6w/registry-types`) and returns a `Registry`
 * with register / get / list / load / lifecycle ops. Storage is the host's
 * responsibility; this module owns the semantics.
 */
export { createRegistry } from "./src/registry.ts";
export type { CreateRegistryOptions, RegisterResult, Registry } from "./src/registry.ts";

export { canonicalJson, digestDescription } from "./src/digest.ts";

export { InMemoryAppDataStore } from "./src/in_memory.ts";

// Re-export the contract types so callers don't need a second import.
export type {
  AppVersion,
  Cursor,
  DataStore,
  EffectiveClassification,
  LifecycleOverlay,
  ListQuery,
  Origin,
  Page,
  PutVersionInput,
  PutVersionResult,
  RegisteredApp,
} from "@w6w/registry-types";
export { effectiveClassification, RegistryError } from "@w6w/registry-types";
