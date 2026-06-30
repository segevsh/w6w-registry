/**
 * The DataStore contract — the seam between the registry and persistence.
 * Hosts (server's Postgres, in-memory tests, …) implement this; the registry
 * library calls it. See core/rfcs/registry.md.
 */
import type { Maturity, Visibility } from "@w6w/types";
import type { AppVersion, LifecycleOverlay, Origin, RegisteredApp } from "./registry.ts";

/** Page size for `list*` operations. */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** Opaque to callers; the data store defines its own encoding. */
export type Cursor = string;

export interface ListQuery {
  /** Substring match against id / name / displayName. */
  q?: string;
  /** Filter by manifest category. */
  category?: string;
  /** Filter by **effective** maturity. */
  maturity?: Maturity;
  /**
   * Filter by **effective** visibility. Default: `["public", "unlisted"]`.
   * Pass `["private","unlisted","public"]` to include private apps.
   */
  visibility?: Visibility[];
  /** Page size. Clamped to [1, MAX_PAGE_SIZE]. Defaults to DEFAULT_PAGE_SIZE. */
  limit?: number;
  /** Opaque cursor from a previous Page. */
  cursor?: Cursor;
}

export interface Page<T> {
  items: T[];
  nextCursor?: Cursor;
}

/** Input the registry hands to `putVersion`. */
export interface PutVersionInput {
  /** Pre-built (and pre-validated) AppVersion the registry computed. */
  version: AppVersion;
  /** Whether to advance the latest pointer if this version's SemVer > current latest. */
  promoteToLatestIfHigher: boolean;
}

export interface PutVersionResult {
  /** The version as actually stored (may be the existing identical row). */
  version: AppVersion;
  /** True if a new row was written; false if an identical (id, version, digest) already existed. */
  registered: boolean;
  /** True if this call advanced the latest pointer. */
  latestAdvanced: boolean;
}

export interface RemoveOptions {
  /** Remove only this specific version. */
  version?: string;
  /** Remove every version (and the latest pointer + overlay). Mutually exclusive with `version`. */
  allVersions?: boolean;
}

/**
 * The data store contract. Implementations MUST honor the atomicity guarantees
 * documented per method.
 */
export interface DataStore {
  /**
   * Insert a new (id, version) row + its actions in one transactional unit.
   *
   * - Same `(id, version)` already exists with the **same digest** → no-op;
   *   return that row with `registered: false`.
   * - Same `(id, version)` exists with a **different digest** → throw a
   *   `RegistryError` with `code: "version_conflict"`.
   * - New `(id, version)` → insert; advance `latest` iff
   *   `promoteToLatestIfHigher && semverGt(newVersion, currentLatest)` (or
   *   if there was no previous latest at all).
   */
  putVersion(input: PutVersionInput): Promise<PutVersionResult>;

  /** Read the aggregate (latest + overlay + counts). Undefined if unknown. */
  getLatest(id: string): Promise<RegisteredApp | undefined>;

  /** Read one specific version. Undefined if unknown. */
  getVersion(id: string, version: string): Promise<AppVersion | undefined>;

  /** List apps (paged, filtered, by **effective** classification). */
  listLatest(query: ListQuery): Promise<Page<RegisteredApp>>;

  /** All versions for an id, newest first by SemVer. */
  listVersions(id: string): Promise<AppVersion[]>;

  /**
   * Remove one or all versions. Cascades to actions. If removing the version
   * currently pointed to as latest, the store MUST repoint to the next-highest
   * remaining SemVer (or clear the pointer if no versions remain).
   * Returns the number of versions removed.
   */
  remove(id: string, opts: RemoveOptions): Promise<number>;

  /** Read-modify-write the overlay. Must be atomic. */
  patchOverlay(id: string, patch: Partial<LifecycleOverlay>): Promise<LifecycleOverlay>;
}

/** Re-exported here so consumers can construct origins without pulling registry.ts. */
export const LOCAL_ORIGIN: Origin = { kind: "local" };
