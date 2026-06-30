/**
 * @w6w/registry-types — the logical model for the App Registry.
 *
 * Pure type definitions plus a tiny set of helpers that compute the *effective*
 * classification (overlay + manifest). Runtime-agnostic and storage-agnostic so
 * any host (server, CLI, in-memory test) can consume the same shapes.
 *
 * See core/rfcs/registry.md.
 */
export * from "./src/registry.ts";
export * from "./src/datastore.ts";
export * from "./src/errors.ts";
