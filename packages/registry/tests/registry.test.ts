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
  assertEquals(result.version.id, "com.w6w.hello");
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
  const v0 = (await registry.get("com.w6w.hello"))!.latest;
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
  assertEquals(page.items[0].id, "com.w6w.hello");
  assertEquals(page.items[0].effective.maturity, "stable");
});

Deno.test("registry: load returns a runnable LoadedApp", async () => {
  const registry = makeRegistry();
  await registry.register(HELLO_DIR);
  const loaded = await registry.load("com.w6w.hello");
  assertEquals(loaded.manifest.id, "com.w6w.hello");
  // Sanity: describe() over the loaded app reproduces what we registered.
  const described = describeApp(loaded);
  assertEquals(described.app.id, "com.w6w.hello");
});

Deno.test("registry: lifecycle overlay overrides manifest classification", async () => {
  const registry = makeRegistry();
  await registry.register(HELLO_DIR);

  await registry.setMaturity("com.w6w.hello", "deprecated");
  await registry.setSuccessor("com.w6w.hello", "com.w6w.hello-next");

  const app = (await registry.get("com.w6w.hello"))!;
  assertEquals(app.effective.maturity, "deprecated");
  assertEquals(app.effective.successor, "com.w6w.hello-next");

  // Clearing brings it back to the manifest's claim.
  await registry.setMaturity("com.w6w.hello", null);
  const cleared = (await registry.get("com.w6w.hello"))!;
  assertEquals(cleared.effective.maturity, "stable");
});

Deno.test("registry: list visibility filter defaults to public+unlisted", async () => {
  const registry = makeRegistry();
  await registry.register(HELLO_DIR);

  await registry.setVisibility("com.w6w.hello", "private");
  const defaultPage = await registry.list({});
  assertEquals(defaultPage.items.length, 0, "private apps hidden by default");

  const explicit = await registry.list({ visibility: ["private", "public", "unlisted"] });
  assertEquals(explicit.items.length, 1);
});

Deno.test("registry: unregister", async () => {
  const registry = makeRegistry();
  await registry.register(HELLO_DIR);
  const { removed } = await registry.unregister("com.w6w.hello", { allVersions: true });
  assertEquals(removed, 1);
  assertEquals(await registry.get("com.w6w.hello"), undefined);
});

Deno.test("registry: load unknown app → RegistryError(unknown_app)", async () => {
  const registry = makeRegistry();
  await assertRejects(
    () => registry.load("com.w6w.nope"),
    RegistryError,
    "is not registered",
  );
});
