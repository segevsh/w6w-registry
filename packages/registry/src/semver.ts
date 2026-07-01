/**
 * Tiny SemVer helpers shared by the registry orchestrator and its reference
 * data store. Handles only the `MAJOR.MINOR.PATCH[-prerelease]` shape the App
 * manifest mandates; non-numeric core segments are treated as `0`.
 */

interface Parsed {
  parts: [number, number, number];
  pre: string | null;
}

function parseSemver(v: string): Parsed {
  const [core, pre] = v.split("-", 2);
  const segs = core.split(".").map((s) => {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  });
  return { parts: [segs[0] ?? 0, segs[1] ?? 0, segs[2] ?? 0], pre: pre ?? null };
}

/** Strict SemVer greater-than. Non-prerelease beats prerelease at equal core parts. */
export function semverGt(a: string, b: string): boolean {
  if (a === b) return false;
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] > pb.parts[i];
  }
  if (!pa.pre && pb.pre) return true;
  if (pa.pre && !pb.pre) return false;
  if (pa.pre && pb.pre) return pa.pre > pb.pre;
  return false;
}

export type BumpKind = "patch" | "minor" | "major";

/** Bump a SemVer core version. Prerelease suffix is dropped (a bump means "publish"). */
export function bumpSemver(v: string, kind: BumpKind): string {
  const { parts } = parseSemver(v);
  const [major, minor, patch] = parts;
  switch (kind) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}
