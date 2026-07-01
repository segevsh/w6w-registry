/**
 * Pack support — read a `w6w-pack.json` manifest from a resolved source dir.
 *
 * Detection is intentionally cheap: `isPackDir(dir)` only stat's the well-known
 * filename. Reading + parsing is separate so callers that just want to route
 * (single-app vs. pack) don't pay the parse cost.
 */
import { join } from "jsr:@std/path@^1.0.0";
import { PACK_MANIFEST_FILENAME, type PackManifest } from "@w6w/types";
import { RegistryError } from "@w6w/registry-types";

/** Cheap detection — true iff `dir/w6w-pack.json` exists and is a regular file. */
export async function isPackDir(dir: string): Promise<boolean> {
  try {
    const info = await Deno.stat(join(dir, PACK_MANIFEST_FILENAME));
    return info.isFile;
  } catch {
    return false;
  }
}

/**
 * Read and validate `w6w-pack.json` from a directory. Throws a `RegistryError`
 * on malformed JSON, missing required fields, or wrong `kind`.
 */
export async function readPackManifest(dir: string): Promise<PackManifest> {
  const file = join(dir, PACK_MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await Deno.readTextFile(file);
  } catch (err) {
    throw new RegistryError(
      "invalid_query",
      `pack: cannot read ${PACK_MANIFEST_FILENAME}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RegistryError(
      "invalid_query",
      `pack: malformed ${PACK_MANIFEST_FILENAME}: ${(err as Error).message}`,
    );
  }
  const m = parsed as Partial<PackManifest>;
  if (m?.kind !== "pack") {
    throw new RegistryError(
      "invalid_query",
      `pack: expected kind "pack" in ${PACK_MANIFEST_FILENAME}, got ${JSON.stringify(m?.kind)}`,
    );
  }
  if (m.manifestVersion !== "1") {
    throw new RegistryError(
      "invalid_query",
      `pack: unsupported manifestVersion "${m.manifestVersion}" (expected "1")`,
    );
  }
  if (typeof m.name !== "string" || m.name.length === 0) {
    throw new RegistryError("invalid_query", `pack: manifest missing "name"`);
  }
  if (!Array.isArray(m.apps)) {
    throw new RegistryError("invalid_query", `pack: manifest missing "apps" array`);
  }
  for (const [i, entry] of m.apps.entries()) {
    if (typeof entry?.path !== "string" || entry.path.length === 0) {
      throw new RegistryError(
        "invalid_query",
        `pack: apps[${i}] is missing string "path"`,
      );
    }
  }
  return m as PackManifest;
}
