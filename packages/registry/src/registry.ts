/**
 * Registry orchestrator: `register`, `get*`, `list*`, `load`, `unregister`,
 * and the lifecycle ops. Storage and source resolution are injected so this
 * module stays transport-free, storage-free, and easy to test.
 */
import type { AppManifest, Maturity, Visibility } from "@w6w/types";
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
import { type BumpKind, bumpSemver, semverGt } from "./semver.ts";

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
  /**
   * Optional transform applied to a loaded app's manifest at register time
   * before the digest is computed and the version is persisted. Intended for
   * hosts that want to make the stored manifest self-contained — e.g. read
   * the icon/screenshot files referenced by relative paths in
   * `appearance.icon` / `screenshots[]` and inline them as `data:` URIs so
   * downstream UIs can render directly without re-resolving the source.
   *
   * The function receives the loaded app (so it can read from `loadedApp.dir`)
   * and the manifest just returned by `describe()`. It returns a new manifest
   * — typically a shallow merge with the inlined fields. The returned
   * manifest is what gets stored and what the digest covers, so changing the
   * icon file content does invalidate the digest (and re-registering bumps
   * the version's content, as expected).
   *
   * Default: identity — paths are stored as-is.
   */
  transformManifest?: (input: {
    loadedApp: LoadedApp;
    manifest: AppManifest;
  }) => Promise<AppManifest>;
}

export interface RegisterResult {
  /** The stored version. */
  version: AppVersion;
  /** True if a new row was written; false if an identical (id, version, digest) already existed. */
  registered: boolean;
  /** True if this call advanced the id's `latest` pointer. */
  latestAdvanced: boolean;
}

export interface RefreshOptions {
  /**
   * How to resolve a same-version-different-content collision. When the
   * re-loaded source's manifest carries the same `version` as the current
   * latest but produces a different digest, the registry auto-bumps the
   * *stored* version by this kind before writing (default: `"patch"`).
   *
   * The source's manifest itself is not modified — the bump only affects
   * what gets persisted. If the source's manifest version is already
   * strictly greater than the current latest, this option is ignored and
   * the source's version is used verbatim.
   */
  versionBump?: BumpKind;
}

export interface RefreshResult extends RegisterResult {
  /** True if the stored version was auto-bumped past the source's manifest version. */
  bumped: boolean;
  /** The source's manifest version, unchanged. Handy for logging / diffing against `version.version`. */
  sourceVersion: string;
}

export interface Registry {
  register(sourceRef: string): Promise<RegisterResult>;
  /**
   * Re-resolve an already-registered app from its stored `sourceRef` and
   * re-register it. Unlike `register`, `refresh` doesn't take a source ref —
   * it uses whatever was recorded when the app was first added.
   *
   * Behavior:
   *  - If the freshly-resolved digest matches the stored latest and versions
   *    match: no-op (`registered: false, bumped: false`).
   *  - If the source's manifest version is strictly greater than the stored
   *    latest: written as a new version (like `register`).
   *  - If the source's manifest version equals the stored latest but the
   *    digest differs (typical for asset-only edits): the stored version is
   *    auto-bumped by `opts.versionBump` (default `"patch"`) and written.
   *  - If the source's manifest version is less than the stored latest:
   *    throws `RegistryError("version_conflict")`.
   */
  refresh(id: string, opts?: RefreshOptions): Promise<RefreshResult>;
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
  const transformManifest = options.transformManifest;

  async function register(sourceRef: string): Promise<RegisterResult> {
    if (typeof sourceRef !== "string" || sourceRef.length === 0) {
      throw new RegistryError("invalid_query", "`sourceRef` must be a non-empty string.");
    }
    const dir = await resolveSource(sourceRef);
    const app = await loadAppFn(dir);
    const described = describe(app);
    const manifest = transformManifest
      ? await transformManifest({ loadedApp: app, manifest: described.app })
      : described.app;
    const digest = await digestDescription({
      manifest,
      actions: described.actions,
      auth: described.auth,
    });

    const version: AppVersion = {
      id: manifest.id,
      version: manifest.version,
      digest,
      sourceRef,
      origin: LOCAL_ORIGIN,
      manifest,
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

  async function refresh(id: string, opts: RefreshOptions = {}): Promise<RefreshResult> {
    const versionBump: BumpKind = opts.versionBump ?? "patch";

    const existing = await store.getLatest(id);
    if (!existing) {
      throw new RegistryError("unknown_app", `App "${id}" is not registered.`);
    }
    const sourceRef = existing.latest.sourceRef;

    const dir = await resolveSource(sourceRef);
    const app = await loadAppFn(dir);
    if (app.manifest.id !== id) {
      throw new RegistryError(
        "manifest_id_mismatch",
        `Registered id "${id}" loaded a manifest with id "${app.manifest.id}".`,
      );
    }
    const described = describe(app);
    const sourceManifest = transformManifest
      ? await transformManifest({ loadedApp: app, manifest: described.app })
      : described.app;
    const sourceVersion = sourceManifest.version;
    const sourceDigest = await digestDescription({
      manifest: sourceManifest,
      actions: described.actions,
      auth: described.auth,
    });

    // Nothing to do: same version + same content as what we already stored.
    if (sourceVersion === existing.latest.version && sourceDigest === existing.latest.digest) {
      return {
        version: existing.latest,
        registered: false,
        latestAdvanced: false,
        bumped: false,
        sourceVersion,
      };
    }

    let manifest = sourceManifest;
    let digest = sourceDigest;
    let bumped = false;

    if (semverGt(sourceVersion, existing.latest.version)) {
      // Source is already ahead — write it as-is.
    } else if (sourceVersion === existing.latest.version) {
      // Same version, different content → auto-bump past the current latest.
      const nextVersion = bumpSemver(existing.latest.version, versionBump);
      manifest = { ...sourceManifest, version: nextVersion };
      digest = await digestDescription({
        manifest,
        actions: described.actions,
        auth: described.auth,
      });
      bumped = true;
    } else {
      // Source went backwards — refuse.
      throw new RegistryError(
        "version_conflict",
        `Source manifest version "${sourceVersion}" is less than the registered latest "${existing.latest.version}".`,
      );
    }

    const version: AppVersion = {
      id: manifest.id,
      version: manifest.version,
      digest,
      sourceRef,
      origin: LOCAL_ORIGIN,
      manifest,
      actions: described.actions,
      auth: described.auth,
      registeredAt: now().toISOString(),
    };

    const result = await store.putVersion({ version, promoteToLatestIfHigher: true });
    return {
      version: result.version,
      registered: result.registered,
      latestAdvanced: result.latestAdvanced,
      bumped,
      sourceVersion,
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
    refresh,
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
