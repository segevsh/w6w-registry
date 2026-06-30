/**
 * Registry error codes + the `RegistryError` class.
 *
 * Mirrors how core's `W6WError` is shaped so hosts can map errors to HTTP
 * status codes uniformly.
 */
export type RegistryErrorCode =
  | "unknown_app"
  | "unknown_version"
  | "version_conflict"
  | "manifest_id_mismatch"
  | "manifest_version_mismatch"
  | "unsupported_origin"
  | "invalid_query"
  | "no_versions_remaining"
  | "storage_error";

export class RegistryError extends Error {
  readonly code: RegistryErrorCode;
  override readonly cause?: unknown;

  constructor(code: RegistryErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }

  toJSON(): { code: RegistryErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}
