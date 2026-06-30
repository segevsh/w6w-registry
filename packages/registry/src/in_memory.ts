/**
 * Reference in-memory `DataStore`. Used by the registry's own tests and as a
 * drop-in for hosts that want an ephemeral registry (e.g. a local dev CLI).
 *
 * Honors the atomicity contract trivially — every method is synchronous in JS
 * memory and yields a Promise only because the interface is async.
 */
import type { Maturity, Visibility } from "@w6w/types";
import {
  type AppVersion,
  type DataStore,
  DEFAULT_PAGE_SIZE,
  effectiveClassification,
  type LifecycleOverlay,
  type ListQuery,
  MAX_PAGE_SIZE,
  type Page,
  type PutVersionInput,
  type PutVersionResult,
  type RegisteredApp,
  RegistryError,
} from "@w6w/registry-types";

interface AppRecord {
  /** Ordered by SemVer ascending (latest is the highest stored). */
  versions: Map<string, AppVersion>;
  /** Currently-latest version key. */
  latest: string;
  overlay: LifecycleOverlay;
  registeredAt: string;
  updatedAt: string;
}

export class InMemoryAppDataStore implements DataStore {
  private readonly byId = new Map<string, AppRecord>();

  // eslint-disable-next-line @typescript-eslint/require-await
  async putVersion(input: PutVersionInput): Promise<PutVersionResult> {
    const { version, promoteToLatestIfHigher } = input;
    const existing = this.byId.get(version.id);

    if (existing) {
      const existingVersion = existing.versions.get(version.version);
      if (existingVersion) {
        if (existingVersion.digest !== version.digest) {
          throw new RegistryError(
            "version_conflict",
            `Version "${version.version}" of "${version.id}" is already registered with a different digest. Bump the manifest version to publish changes.`,
          );
        }
        // Identical content: no-op.
        return { version: existingVersion, registered: false, latestAdvanced: false };
      }
      existing.versions.set(version.version, version);
      existing.updatedAt = version.registeredAt;
      let latestAdvanced = false;
      if (promoteToLatestIfHigher && semverGt(version.version, existing.latest)) {
        existing.latest = version.version;
        latestAdvanced = true;
      }
      return { version, registered: true, latestAdvanced };
    }

    // Brand new id.
    this.byId.set(version.id, {
      versions: new Map([[version.version, version]]),
      latest: version.version,
      overlay: {},
      registeredAt: version.registeredAt,
      updatedAt: version.registeredAt,
    });
    return { version, registered: true, latestAdvanced: true };
  }

  getLatest(id: string): Promise<RegisteredApp | undefined> {
    const rec = this.byId.get(id);
    if (!rec) return Promise.resolve(undefined);
    return Promise.resolve(this.toRegisteredApp(id, rec));
  }

  getVersion(id: string, version: string): Promise<AppVersion | undefined> {
    return Promise.resolve(this.byId.get(id)?.versions.get(version));
  }

  listLatest(query: ListQuery): Promise<Page<RegisteredApp>> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const visibilities = new Set<Visibility>(query.visibility ?? ["public", "unlisted"]);
    const q = query.q?.toLowerCase();

    const all: RegisteredApp[] = [];
    for (const [id, rec] of this.byId) {
      const app = this.toRegisteredApp(id, rec);
      if (q) {
        const hay = (id + " " + app.latest.manifest.name + " " + app.latest.manifest.displayName)
          .toLowerCase();
        if (!hay.includes(q)) continue;
      }
      if (query.category && !app.latest.manifest.categories.includes(query.category)) continue;
      if (query.maturity && app.effective.maturity !== query.maturity) continue;
      if (!visibilities.has(app.effective.visibility)) continue;
      all.push(app);
    }
    // Stable, deterministic order: newest update first, then id.
    all.sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
      return a.id < b.id ? -1 : 1;
    });

    const startIdx = query.cursor ? decodeCursor(query.cursor) : 0;
    const slice = all.slice(startIdx, startIdx + limit);
    const nextIdx = startIdx + slice.length;
    const nextCursor = nextIdx < all.length ? encodeCursor(nextIdx) : undefined;

    return Promise.resolve({ items: slice, nextCursor });
  }

  listVersions(id: string): Promise<AppVersion[]> {
    const rec = this.byId.get(id);
    if (!rec) return Promise.resolve([]);
    const versions = [...rec.versions.values()];
    versions.sort((a, b) => (semverGt(a.version, b.version) ? -1 : 1));
    return Promise.resolve(versions);
  }

  remove(
    id: string,
    opts: { version?: string; allVersions?: boolean },
  ): Promise<number> {
    const rec = this.byId.get(id);
    if (!rec) return Promise.resolve(0);

    if (opts.allVersions) {
      const n = rec.versions.size;
      this.byId.delete(id);
      return Promise.resolve(n);
    }

    if (opts.version) {
      if (!rec.versions.has(opts.version)) return Promise.resolve(0);
      rec.versions.delete(opts.version);
      if (rec.versions.size === 0) {
        this.byId.delete(id);
      } else if (rec.latest === opts.version) {
        // Repoint to the highest remaining SemVer.
        let next = "";
        for (const v of rec.versions.keys()) {
          if (!next || semverGt(v, next)) next = v;
        }
        rec.latest = next;
        rec.updatedAt = new Date().toISOString();
      }
      return Promise.resolve(1);
    }

    // Neither specified → ambiguous; treat as no-op.
    return Promise.resolve(0);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async patchOverlay(id: string, patch: Partial<LifecycleOverlay>): Promise<LifecycleOverlay> {
    const rec = this.byId.get(id);
    if (!rec) {
      throw new RegistryError("unknown_app", `App "${id}" is not registered.`);
    }
    // Treat undefined entries in the patch as "clear" — matches setMaturity(null) etc.
    const next: LifecycleOverlay = { ...rec.overlay };
    for (const k of Object.keys(patch) as (keyof LifecycleOverlay)[]) {
      const v = patch[k];
      if (v === undefined) delete (next as Record<string, unknown>)[k];
      else (next as Record<string, unknown>)[k] = v;
    }
    rec.overlay = next;
    rec.updatedAt = new Date().toISOString();
    return next;
  }

  private toRegisteredApp(id: string, rec: AppRecord): RegisteredApp {
    const latest = rec.versions.get(rec.latest)!;
    return {
      id,
      latest,
      versionCount: rec.versions.size,
      overlay: { ...rec.overlay },
      effective: effectiveClassification(latest.manifest, rec.overlay),
      registeredAt: rec.registeredAt,
      updatedAt: rec.updatedAt,
    };
  }
}

/**
 * Tiny SemVer comparator — only handles the `MAJOR.MINOR.PATCH[-prerelease]`
 * shape the App manifest mandates. Non-numeric segments compare lexically.
 * Prerelease versions sort below their non-prerelease counterpart.
 */
function semverGt(a: string, b: string): boolean {
  if (a === b) return false;
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] > pb.parts[i];
  }
  // Equal core parts → a non-prerelease beats a prerelease; otherwise lex on prerelease.
  if (!pa.pre && pb.pre) return true;
  if (pa.pre && !pb.pre) return false;
  if (pa.pre && pb.pre) return pa.pre > pb.pre;
  return false;
}

function parseSemver(v: string): { parts: [number, number, number]; pre: string | null } {
  const [core, pre] = v.split("-", 2);
  const segs = core.split(".").map((s) => {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  });
  return {
    parts: [segs[0] ?? 0, segs[1] ?? 0, segs[2] ?? 0],
    pre: pre ?? null,
  };
}

function encodeCursor(idx: number): string {
  return btoa(`o:${idx}`);
}

function decodeCursor(cursor: string): number {
  try {
    const decoded = atob(cursor);
    if (!decoded.startsWith("o:")) return 0;
    const n = Number(decoded.slice(2));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
