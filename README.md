# w6w-registry

Reference implementation of the w6w **App Registry** — a transport-free,
storage-agnostic library a host plugs a `DataStore` into to manage a
collection of registered Apps.

> **Status:** Development · **Spec:** `registryVersion: "1"` (Draft) · **License:** MIT

The specification lives upstream in **`core`**, alongside the rest of the
platform RFCs:
[`w6w-io/w6w-core/rfcs/registry.md`](https://github.com/w6w-io/w6w-core/blob/main/rfcs/registry.md).

## Purpose

`core` defines what an App *is* (manifest, actions, auth, invocations) **and
what a Registry is**. This repo is the reference implementation of that
Registry RFC: how a host stores, looks up, versions, and serves apps to its
runtime.

The registry is **transport-free and storage-free**: it owns the semantics
(register / get / list / lifecycle / load) and depends on an injected
[`DataStore`](./packages/types/src/datastore.ts) for persistence. The server
(or any host) supplies the data store; the registry hands back a ready-to-use
`Registry` object.

```
host (server)                                  registry (this repo)              core
  └─ PostgresDataStore  ──── inject ─────► createRegistry({ store, ... })
                                                  │
                                                  ├─ register(sourceRef)  ─► @w6w/sources + @w6w/runtime
                                                  ├─ get(id) / list(query)
                                                  ├─ load(id) ─► LoadedApp ──► @w6w/runtime.invoke
                                                  └─ lifecycle (maturity / visibility / successor)
```

## Layout

```
w6w-registry/
└── packages/
    ├── types/              # @w6w/registry-types — RegisteredApp, DataStore iface, errors
    └── registry/           # @w6w/registry — orchestrator + reference InMemoryAppDataStore
```

A Deno workspace (`deno.json`). Run `deno task test` to exercise it.

## Design principles

- **Datastore-pluggable.** The registry never talks SQL. Hosts implement
  `DataStore` and inject it. Tests use the in-memory implementation.
- **Versioned by default.** Apps are stored per `(id, version)`. A `latest`
  pointer (per id) drives unqualified `get(id)` and `list()`.
- **Content-addressable idempotency.** Re-registering the same source twice
  is a no-op when the resolved description's content digest matches. A bumped
  manifest `version` produces a new row; the prior version is preserved.
- **Lifecycle overlay.** Lifecycle ops (`setMaturity`, `setVisibility`,
  `setSuccessor`) store an **override** on top of the manifest, so a host can
  deprecate an app without rebuilding it. The effective classification is
  `override ?? manifest.classification`.
- **Federation-ready.** Each registered version carries an `origin`
  (`"local"` today; `"federated"` reserved). The shape is designed so a
  later RFC can specify upstream pull / mirror semantics without changing
  the local-host contract.

## Development

This library depends on three `core` packages — `@w6w/types`, `@w6w/runtime`,
`@w6w/sources`. The workspace's `deno.json` currently points at sibling paths
(`../../../core/packages/...`) because development happens inside the w6w
monorepo. Standalone consumers should import the published packages from JSR
or npm; rewiring this repo's `imports` map to JSR refs is a planned cleanup
once core's full package set is released there.

See [`core/rfcs/registry.md`](https://github.com/w6w-io/w6w-core/blob/main/rfcs/registry.md)
for the spec.
