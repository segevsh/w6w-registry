/**
 * Registry orchestrator: `register`, `get*`, `list*`, `load`, `unregister`,
 * and the lifecycle ops. Storage and source resolution are injected so this
 * module stays transport-free, storage-free, and easy to test.
 */
import type { Maturity, Visibility } from "@w6w/types";
import { describe, loadApp, type LoadedApp } from "@w6w/runtime";
import { resolve as resolveSourceDefault } from "@w6w/sources";
import {
  type AppVersion,
  type DataStore,
  effectiveClassification,
  type LifecycleOverlay,
  type ListQuery,
  LOCAL_ORIGIN,
  type Page,
  type PutVersionResult,
  type RegisteredApp,
  RegistryError,
} from "@w6w/registry-types";
import { digestDescription } from "./digest.ts";

export interface CreateRegistryOptions {
  /** The persistence backend. The only required dependency. */
  store: DataStore;
  /**
   * Source-ref → local dir resolver. Defaults to `@w6w/sources`'s `resolve`.
   * Override in tests to point at fixtures without hitting the resolver registry.
   */
  resolveSource?: (ref: string) => Promise<string>;
  /**
   * Dir → LoadedApp loader. Defaults to `@w6w/runtime.loadApp`. Override only
   * when stubbing the load step (e.g. unit tests).
   */
  loadAppFn?: (dir: string) => Promise<LoadedApp>;
  /**
   * Clock for `registeredAt` timestamps. Defaults to `() => new Date()`.
   * Tests can pass a frozen clock for deterministic snapshots.
   */
  now?: () => Date;
}

export interface RegisterResult {
  /** The stored version. */
  version: AppVersion;
  /** True if a new row was written; false if an identical (id, version, digest) already existed. */
  registered: boolean;
  /** True if this call advanced the id's `latest` pointer. */
  latestAdvanced: boolean;
}

export interface Registry {
  register(sourceRef: string): Promise<RegisterResult>;
  get(id: string): Promise<RegisteredApp | undefined>;
  getVersion(id: string, version: string): Promise<AppVersion | undefined>;
  list(query?: ListQuery): Promise<Page<RegisteredApp>>;
  listVersions(id: string): Promise<AppVersion[]>;
  /**
   * Re-resolve the stored `sourceRef` for an id (defaulting to its latest
   * version) and return a runnable `LoadedApp`. Hand this straight to
   * `@w6w/runtime.invoke` or `describe`.
   */
  load(id: string, opts?: { version?: string }): Promise<LoadedApp>;
  unregister(
    id: string,
    opts?: { version?: string; allVersions?: boolean },
  ): Promise<{ removed: number }>;
  setMaturity(id: string, maturity: Maturity | null): Promise<LifecycleOverlay>;
  setVisibility(id: string, visibility: Visibility | null): Promise<LifecycleOverlay>;
  setSuccessor(id: string, successor: string | null): Promise<LifecycleOverlay>;
}

export function createRegistry(options: CreateRegistryOptions): Registry {
  const store = options.store;
  const resolveSource = options.resolveSource ?? resolveSourceDefault;
  const loadAppFn = options.loadAppFn ?? loadApp;
  const now = options.now ?? (() => new Date());

  async function register(sourceRef: string): Promise<RegisterResult> {
    if (typeof sourceRef !== "string" || sourceRef.length === 0) {
      throw new RegistryError("invalid_query", "`sourceRef` must be a non-empty string.");
    }
    const dir = await resolveSource(sourceRef);
    const app = await loadAppFn(dir);
    const described = describe(app);
    const digest = await digestDescription({
      manifest: described.app,
      actions: described.actions,
      auth: described.auth,
    });

    const version: AppVersion = {
      id: described.app.id,
      version: described.app.version,
      digest,
      sourceRef,
      origin: LOCAL_ORIGIN,
      manifest: described.app,
      actions: described.actions,
      auth: described.auth,
      registeredAt: now().toISOString(),
    };

    const result: PutVersionResult = await store.putVersion({
      version,
      promoteToLatestIfHigher: true,
    });

    return {
      version: result.version,
      registered: result.registered,
      latestAdvanced: result.latestAdvanced,
    };
  }

  async function get(id: string): Promise<RegisteredApp | undefined> {
    return await store.getLatest(id);
  }

  async function getVersion(id: string, version: string): Promise<AppVersion | undefined> {
    return await store.getVersion(id, version);
  }

  async function list(query: ListQuery = {}): Promise<Page<RegisteredApp>> {
    return await store.listLatest(query);
  }

  async function listVersions(id: string): Promise<AppVersion[]> {
    return await store.listVersions(id);
  }

  async function load(
    id: string,
    opts: { version?: string } = {},
  ): Promise<LoadedApp> {
    // Pick the right stored version, then re-resolve + reload it.
    let stored: AppVersion | undefined;
    if (opts.version) {
      stored = await store.getVersion(id, opts.version);
      if (!stored) {
        throw new RegistryError(
          "unknown_version",
          `App "${id}" has no version "${opts.version}".`,
        );
      }
    } else {
      const aggregate = await store.getLatest(id);
      if (!aggregate) {
        throw new RegistryError("unknown_app", `App "${id}" is not registered.`);
      }
      stored = aggregate.latest;
    }
    const dir = await resolveSource(stored.sourceRef);
    const app = await loadAppFn(dir);
    // Defense in depth: the stored manifest must match what we just loaded.
    if (app.manifest.id !== id) {
      throw new RegistryError(
        "manifest_id_mismatch",
        `Registered id "${id}" loaded a manifest with id "${app.manifest.id}".`,
      );
    }
    if (opts.version && app.manifest.version !== opts.version) {
      throw new RegistryError(
        "manifest_version_mismatch",
        `Registered version "${opts.version}" loaded manifest version "${app.manifest.version}".`,
      );
    }
    return app;
  }

  async function unregister(
    id: string,
    opts: { version?: string; allVersions?: boolean } = {},
  ): Promise<{ removed: number }> {
    if (opts.version && opts.allVersions) {
      throw new RegistryError(
        "invalid_query",
        "Pass either `version` or `allVersions`, not both.",
      );
    }
    const removed = await store.remove(id, opts);
    if (removed === 0) {
      throw new RegistryError(
        opts.version ? "unknown_version" : "unknown_app",
        opts.version
          ? `App "${id}" has no version "${opts.version}".`
          : `App "${id}" is not registered.`,
      );
    }
    return { removed };
  }

  async function setMaturity(id: string, maturity: Maturity | null) {
    return await assertExistsThen(
      id,
      () => store.patchOverlay(id, { maturity: maturity ?? undefined }),
    );
  }
  async function setVisibility(id: string, visibility: Visibility | null) {
    return await assertExistsThen(
      id,
      () => store.patchOverlay(id, { visibility: visibility ?? undefined }),
    );
  }
  async function setSuccessor(id: string, successor: string | null) {
    return await assertExistsThen(
      id,
      () => store.patchOverlay(id, { successor: successor ?? undefined }),
    );
  }

  async function assertExistsThen<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const exists = await store.getLatest(id);
    if (!exists) throw new RegistryError("unknown_app", `App "${id}" is not registered.`);
    return await fn();
  }

  return {
    register,
    get,
    getVersion,
    list,
    listVersions,
    load,
    unregister,
    setMaturity,
    setVisibility,
    setSuccessor,
  };
}

// Surface this helper to consumers building their own data store who want the
// effective-classification calc to stay consistent with the registry's view.
export { effectiveClassification };
