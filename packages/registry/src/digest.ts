/**
 * Content addressing for AppVersion. The digest is a sha-256 over the
 * canonicalized `{ manifest, actions, auth }` produced by `@w6w/runtime.describe()`.
 *
 * Canonical JSON: keys sorted at every object level; `undefined` omitted;
 * arrays in source order; numbers and strings in their JSON form. This matches
 * the spec in registry.md.
 */
import type { Action, AppManifest, Auth } from "@w6w/types";

/** Canonical-JSON-serialize a value: sorted keys, dropped `undefined`. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

/** sha-256 → hex. Uses the platform Web Crypto API (works in Deno, browsers, Node 20+). */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface DigestInput {
  manifest: AppManifest;
  actions: Action[];
  auth: Auth[];
}

/** Compute the registry's content digest for a described app. */
export async function digestDescription(input: DigestInput): Promise<string> {
  // Drop the runtime-internal `assetsRoot` (an absolute host-side path) before
  // digesting — it would otherwise make the digest depend on where the app was
  // resolved on the local filesystem. Everything else (id, version, manifest
  // fields, actions, auth) stays.
  const manifest = { ...input.manifest };
  delete (manifest as { assetsRoot?: string }).assetsRoot;
  return await sha256Hex(canonicalJson({
    manifest,
    actions: input.actions,
    auth: input.auth,
  }));
}
