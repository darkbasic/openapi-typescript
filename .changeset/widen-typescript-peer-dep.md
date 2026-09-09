---
"openapi-typescript": patch
"openapi-typescript-helpers": patch
---

Support TypeScript 6 alongside TypeScript 5.

Fix `Readable<T>` and `Writable<T>` to preserve function signatures, including methods on `Date` and `RegExp`, while continuing to filter read-only and write-only properties. This fixes a pre-existing issue under both TypeScript versions, in the helpers package and in the helper types generated with `--read-write-markers`.

Fix readonly-array methods and iteration to expose resolved elements, including schemas generated with `--immutable`, while preserving readonly positional properties, length, and additional data properties. Keep the existing mutable-tuple projection and support recursive arrays and tuples. Excluded elements in readonly collections now follow the same `never` element rule as mutable arrays. Callable types remain unchanged, including their parameters, return types, and attached properties.
