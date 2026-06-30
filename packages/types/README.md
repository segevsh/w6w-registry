# @w6w/registry-types

Logical types and the `DataStore` contract for the w6w **App Registry**. See
the spec at
[`w6w-io/w6w-core/rfcs/registry.md`](https://github.com/w6w-io/w6w-core/blob/main/rfcs/registry.md).

Dependency-free at runtime (apart from `@w6w/types`); safe to import from the editor, server, CLI,
or any host without dragging in I/O.

## Exports

```ts
import {
  type AppVersion,
  type Cursor,
  // data-store contract
  type DataStore,
  DEFAULT_PAGE_SIZE,
  type EffectiveClassification,
  effectiveClassification,
  type LifecycleOverlay,
  type ListQuery,
  LOCAL_ORIGIN,
  MAX_PAGE_SIZE,
  type Origin,
  type Page,
  type PutVersionInput,
  type PutVersionResult,
  // shapes
  type RegisteredApp,
  // errors
  RegistryError,
  type RegistryErrorCode,
} from "@w6w/registry-types";
```
