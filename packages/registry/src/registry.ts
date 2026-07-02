/**
 * Registry orchestrator: `register`, `get*`, `list*`, `load`, `unregister`,
 * and the lifecycle ops. Storage and source resolution are injected so this
 * module stays transport-free, storage-free, and easy to test.
 */
import { resolve as resolvePath } from "jsr:@std/path@^1.0.0";
import type { AppManifest, Maturity, PackAppEntry, PackManifest, Visibility } from "@w6w/types";
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
import { isPackDir, readPackManifest } from "./pack.ts";
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

/**
 * Per-entry outcome inside a Pack install. Failures never halt the pack:
 * every entry is attempted, and the aggregate result tells the caller which
 * ones landed and which didn't.
 */
export type PackEntryResult =
  | { path: string; ok: true; result: RegisterResult }
  | { path: string; ok: false; error: { code: string; message: string }; optional?: boolean };

export interface PackRegisterResult {
  /** The pack manifest, as read from `w6w-pack.json`. */
  pack: PackManifest;
  /**
   * One entry per pack app that was *considered*. When `RegisterPackOptions.paths`
   * is set, this only contains the entries that matched the filter. Manifest
   * order is preserved.
   */
  results: PackEntryResult[];
  /** Count of entries that successfully registered a new version (or were idempotent no-ops). */
  registered: number;
  /** Count of entries that failed. Optional-flagged failures still count here. */
  failed: number;
}

export interface RegisterPackOptions {
  /**
   * Optional whitelist of entry paths (as declared in `w6w-pack.json.apps[].path`)
   * to install. When present, entries not in the set are silently skipped —
   * they do not appear in `results` and do not affect `registered` / `failed`.
   * Useful for a UI that lets a user pick a subset from a checkbox list.
   *
   * Paths must match the manifest entry's `path` field exactly.
   */
  paths?: string[];
}

export interface Registry {
  register(sourceRef: string): Promise<RegisterResult>;
  /**
   * Install a Pack — a `w6w-pack.json` at the resolved sourceRef declares one
   * or more App directories to register together. Each entry runs through the
   * same single-App pipeline as `register`; failures are captured per-entry
   * rather than aborting the whole pack.
   *
   * Preconditions:
   *  - `sourceRef` resolves to a directory that contains `w6w-pack.json`.
   *  - Non-pack refs throw `RegistryError("invalid_query")` — call `register`
   *    for those.
   *
   * `opts.paths`, when set, limits which entries are installed (a subset of
   * the manifest's `apps[].path` values). Unmatched entries are silently
   * skipped so a UI that lets a user check off entries can drive this directly.
   */
  registerPack(sourceRef: string, opts?: RegisterPackOptions): Promise<PackRegisterResult>;
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
    return await registerFromDir(dir, sourceRef);
  }

  /**
   * Shared "load + describe + digest + putVersion" pipeline. Used by both
   * `register` (from a resolved sourceRef) and `registerPack` (from a
   * per-entry directory inside a pack root). The `sourceRef` recorded on the
   * stored AppVersion identifies where the App was loaded from — for a pack
   * entry this is the entry's sub-path.
   */
  async function registerFromDir(dir: string, sourceRef: string): Promise<RegisterResult> {
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

  async function registerPack(
    sourceRef: string,
    opts: RegisterPackOptions = {},
  ): Promise<PackRegisterResult> {
    if (typeof sourceRef !== "string" || sourceRef.length === 0) {
      throw new RegistryError("invalid_query", "`sourceRef` must be a non-empty string.");
    }
    const packDir = await resolveSource(sourceRef);
    if (!(await isPackDir(packDir))) {
      throw new RegistryError(
        "invalid_query",
        `pack: sourceRef "${sourceRef}" resolved to ${packDir}, which has no w6w-pack.json. Use register() for single-app refs.`,
      );
    }
    const pack = await readPackManifest(packDir);
    const pathFilter = opts.paths ? new Set(opts.paths) : null;

    const results: PackEntryResult[] = [];
    let registered = 0;
    let failed = 0;

    for (const entry of pack.apps) {
      if (pathFilter && !pathFilter.has(entry.path)) continue;
      // `resolve` treats an absolute entry.path as-is and joins relative ones
      // against packDir. Matches the shell's `cd $packDir && cd $path` semantics.
      const entryDir = resolvePath(packDir, entry.path);
      // Recorded sourceRef pins the entry sub-path so `refresh` re-resolves the
      // exact same directory (independent of pack membership changes).
      const entrySourceRef = `${sourceRef}#${entry.path}`;
      try {
        const result = await registerFromDir(entryDir, entrySourceRef);
        assertEntryPinsMatch(entry, result);
        results.push({ path: entry.path, ok: true, result });
        registered++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof RegistryError ? err.code : "install_failed";
        results.push({
          path: entry.path,
          ok: false,
          error: { code, message },
          ...(entry.optional ? { optional: true } : {}),
        });
        failed++;
      }
    }

    return { pack, results, registered, failed };
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
    registerPack,
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

/**
 * Enforce a pack entry's optional `id` / `version` pins against the actual
 * registered result. Thrown errors are caught by the registerPack loop and
 * captured as a failed entry — the entry still counts against `failed`.
 */
function assertEntryPinsMatch(entry: PackAppEntry, result: RegisterResult): void {
  if (entry.id && result.version.id !== entry.id) {
    throw new RegistryError(
      "manifest_id_mismatch",
      `pack: entry "${entry.path}" declared id "${entry.id}" but loaded manifest id "${result.version.id}"`,
    );
  }
  if (entry.version && result.version.version !== entry.version) {
    throw new RegistryError(
      "manifest_version_mismatch",
      `pack: entry "${entry.path}" declared version "${entry.version}" but loaded manifest version "${result.version.version}"`,
    );
  }
}

// Surface this helper to consumers building their own data store who want the
// effective-classification calc to stay consistent with the registry's view.
export { effectiveClassification };
