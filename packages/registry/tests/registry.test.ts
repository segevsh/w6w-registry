/**
 * End-to-end tests against an InMemoryAppDataStore — exercise register
 * idempotency, version-conflict, version history, lifecycle overlay, load, and
 * unregister.
 *
 * Uses the `hello` fixture app shipped with `core/`.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl, resolve as resolvePath } from "jsr:@std/path@^1.0.0";
import { describe as describeApp } from "@w6w/runtime";
import { createRegistry, InMemoryAppDataStore, RegistryError } from "../mod.ts";

const HELLO_DIR = resolvePath(
  fromFileUrl(import.meta.url),
  "../../../../../core/fixtures/apps/hello",
);

function makeRegistry() {
  return createRegistry({
    store: new InMemoryAppDataStore(),
    // Bypass the source resolver registry: register() passes the bare local
    // path through verbatim, then `loadApp` reads from disk.
    resolveSource: (ref) => Promise.resolve(ref),
    now: () => new Date("2026-06-30T12:00:00Z"),
  });
}

Deno.test("registry: register the hello fixture", async () => {
  const registry = makeRegistry();
  const result = await registry.register(HELLO_DIR);
  assertEquals(result.registered, true);
  assertEquals(result.latestAdvanced, true);
  assertEquals(result.version.id, "io.w6w.hello");
  assertEquals(result.version.origin.kind, "local");
  assert(result.version.digest.length === 64, "digest is sha-256 hex");
  assert(result.version.actions.length > 0, "fixture exposes actions");
});

Deno.test("registry: re-registering identical content is a no-op", async () => {
  const registry = makeRegistry();
  await registry.register(HELLO_DIR);
  const again = await registry.register(HELLO_DIR);
  assertEquals(again.registered, false);
  assertEquals(again.latestAdvanced, false);
});

Deno.test("registry: same (id, version) with different content → version_conflict", async () => {
  const store = new InMemoryAppDataStore();
  const registry = createRegistry({
    store,
    resolveSource: (ref) => Promise.resolve(ref),
    now: () => new Date("2026-06-30T12:00:00Z"),
  });

  await registry.register(HELLO_DIR);

  // Pretend a second registration produces a different digest for the same
  // version. The cleanest way to simulate it is to write directly through the
  // store — that's the layer the conflict check lives on.
  const v0 = (await registry.get("io.w6w.hello"))!.latest;
  const err = await assertRejects(
    () =>
      store.putVersion({
        version: { ...v0, digest: "deadbeef".repeat(8) },
        promoteToLatestIfHigher: true,
      }),
    RegistryError,
    "already registered with a different digest",
  );
  assertEquals(err.code, "version_conflict");
});

Deno.test("registry: list returns paged RegisteredApps", async () => {
  const registry = makeRegistry();
  await registry.register(HELLO_DIR);
  const page = await registry.list({});
  assertEquals(page.items.length, 1);
  assertEquals(page.items[0].id, "io.w6w.hello");
  assertEquals(page.items[0].effective.maturity, "stable");
});

Deno.test("registry: load returns a runnable LoadedApp", async () => {
  const registry = makeRegistry();
  await registry.register(HELLO_DIR);
  const loaded = await registry.load("io.w6w.hello");
  assertEquals(loaded.manifest.id, "io.w6w.hello");
  // Sanity: describe() over the loaded app reproduces what we registered.
  const described = describeApp(loaded);
  assertEquals(described.app.id, "io.w6w.hello");
});

Deno.test("registry: lifecycle overlay overrides manifest classification", async () => {
  const registry = makeRegistry();
  await registry.register(HELLO_DIR);

  await registry.setMaturity("io.w6w.hello", "deprecated");
  await registry.setSuccessor("io.w6w.hello", "io.w6w.hello-next");

  const app = (await registry.get("io.w6w.hello"))!;
  assertEquals(app.effective.maturity, "deprecated");
  assertEquals(app.effective.successor, "io.w6w.hello-next");

  // Clearing brings it back to the manifest's claim.
  await registry.setMaturity("io.w6w.hello", null);
  const cleared = (await registry.get("io.w6w.hello"))!;
  assertEquals(cleared.effective.maturity, "stable");
});

Deno.test("registry: list visibility filter defaults to public+unlisted", async () => {
  const registry = makeRegistry();
  await registry.register(HELLO_DIR);

  await registry.setVisibility("io.w6w.hello", "private");
  const defaultPage = await registry.list({});
  assertEquals(defaultPage.items.length, 0, "private apps hidden by default");

  const explicit = await registry.list({ visibility: ["private", "public", "unlisted"] });
  assertEquals(explicit.items.length, 1);
});

Deno.test("registry: unregister", async () => {
  const registry = makeRegistry();
  await registry.register(HELLO_DIR);
  const { removed } = await registry.unregister("io.w6w.hello", { allVersions: true });
  assertEquals(removed, 1);
  assertEquals(await registry.get("io.w6w.hello"), undefined);
});

Deno.test("registry: load unknown app → RegistryError(unknown_app)", async () => {
  const registry = makeRegistry();
  await assertRejects(
    () => registry.load("io.w6w.nope"),
    RegistryError,
    "is not registered",
  );
});

Deno.test("registry: refresh unchanged source is a no-op", async () => {
  const registry = makeRegistry();
  await registry.register(HELLO_DIR);
  const result = await registry.refresh("io.w6w.hello");
  assertEquals(result.registered, false);
  assertEquals(result.latestAdvanced, false);
  assertEquals(result.bumped, false);
  assertEquals(result.sourceVersion, "1.0.0");
  assertEquals(result.version.version, "1.0.0");
});

Deno.test("registry: refresh auto-bumps patch when source content changes but version doesn't", async () => {
  // Simulate a source-content change by injecting a transformManifest hook
  // that mutates the manifest between the initial register and the refresh —
  // the digest picks up the change even though the fixture on disk is untouched.
  let mutateDescription = false;
  const registry = createRegistry({
    store: new InMemoryAppDataStore(),
    resolveSource: (ref) => Promise.resolve(ref),
    now: () => new Date("2026-06-30T12:00:00Z"),
    transformManifest: ({ manifest }) =>
      Promise.resolve(mutateDescription ? { ...manifest, description: "updated" } : manifest),
  });

  await registry.register(HELLO_DIR);
  mutateDescription = true;
  const refreshed = await registry.refresh("io.w6w.hello");

  assertEquals(refreshed.registered, true, "wrote a new row");
  assertEquals(refreshed.latestAdvanced, true, "advanced the latest pointer");
  assertEquals(refreshed.bumped, true, "auto-bumped the stored version");
  assertEquals(refreshed.sourceVersion, "1.0.0");
  assertEquals(refreshed.version.version, "1.0.1", "patch-bumped past source version");
  assertEquals(refreshed.version.manifest.description, "updated");

  const versions = await registry.listVersions("io.w6w.hello");
  assertEquals(versions.map((v) => v.version).sort(), ["1.0.0", "1.0.1"]);
});

Deno.test("registry: refresh honors versionBump=minor", async () => {
  let mutate = false;
  const registry = createRegistry({
    store: new InMemoryAppDataStore(),
    resolveSource: (ref) => Promise.resolve(ref),
    now: () => new Date("2026-06-30T12:00:00Z"),
    transformManifest: ({ manifest }) =>
      Promise.resolve(mutate ? { ...manifest, description: "updated" } : manifest),
  });
  await registry.register(HELLO_DIR);
  mutate = true;
  const refreshed = await registry.refresh("io.w6w.hello", { versionBump: "minor" });
  assertEquals(refreshed.version.version, "1.1.0");
});

Deno.test("registry: refresh unknown app → RegistryError(unknown_app)", async () => {
  const registry = makeRegistry();
  await assertRejects(
    () => registry.refresh("io.w6w.nope"),
    RegistryError,
    "is not registered",
  );
});
