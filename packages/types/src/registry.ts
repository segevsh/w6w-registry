/**
 * Logical types for the App Registry. See core/rfcs/registry.md.
 */
import type { Action, AppManifest, Auth, Maturity, Visibility } from "@w6w/types";

/** Where a registered version came from. v1 only ever writes `local`. */
export type Origin =
  | { kind: "local" }
  | { kind: "federated"; upstream: string };

/** Host-side overrides layered on top of a manifest's `classification`. */
export interface LifecycleOverlay {
  maturity?: Maturity;
  visibility?: Visibility;
  /** Reverse-DNS id of the App that replaces this one. */
  successor?: string;
}

/** What hosts should display — overlay precedes manifest precedes defaults. */
export interface EffectiveClassification {
  maturity: Maturity;
  visibility: Visibility;
  successor?: string;
}

/** One stored version of an App. Immutable once written. */
export interface AppVersion {
  /** The App's reverse-DNS id (matches `manifest.id`). */
  id: string;
  /** The manifest's `version` field. SemVer. */
  version: string;
  /** Content digest: sha-256 of canonical({ manifest, actions, auth }). Hex. */
  digest: string;
  /** Source reference this version was registered from. */
  sourceRef: string;
  /** Provenance of this version. */
  origin: Origin;
  /** The full manifest as returned by @w6w/runtime.describe(). */
  manifest: AppManifest;
  /** Action definitions exposed by this version. */
  actions: Action[];
  /** Auth methods declared by this version. */
  auth: Auth[];
  /** When this version was first written to the registry. */
  registeredAt: string;
}

/** Aggregate view of an id: its latest version plus host-side overlay. */
export interface RegisteredApp {
  id: string;
  latest: AppVersion;
  versionCount: number;
  overlay: LifecycleOverlay;
  effective: EffectiveClassification;
  /** When `id` was first registered. */
  registeredAt: string;
  /** When any version under this id was last touched. */
  updatedAt: string;
}

/** Compute the effective classification for a manifest + overlay. */
export function effectiveClassification(
  manifest: AppManifest,
  overlay: LifecycleOverlay,
): EffectiveClassification {
  const c = manifest.classification;
  return {
    maturity: overlay.maturity ?? c?.maturity ?? "stable",
    visibility: overlay.visibility ?? c?.visibility ?? "public",
    successor: overlay.successor ?? c?.successor,
  };
}
