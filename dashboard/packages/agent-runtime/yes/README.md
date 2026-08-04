# yes

The single retry / caching / in-flight-dedup / scheduling primitive used across this monorepo. Wraps async functions with **caching**, **in-flight deduplication**, **retries**, and optional **[Standard Schema](https://github.com/standard-schema/standard-schema) validation**.

Lives inside `action/` so the OSS publish (`action/` rsynced to `polaris/agent-runtime`, then `npm publish polaris`) stays self-contained - no sibling workspace package. Import as `from "polaris/yes"` from root code, or relatively `from "../yes/index.ts"` from inside `action/`.

## `op`

Wrap any async function with `op` to get caching, deduplication, and retries for free.

```ts
import { op } from "polaris/yes";

const getUser = op(async (id: string) => {
  return db.users.findUnique({ where: { id } });
}, { ttl: 60_000 });

await getUser("abc"); // executes
await getUser("abc"); // cache hit
```

Without `ttl`, there's no LRU cache - but concurrent calls with the same key are still deduplicated:

```ts
const getUser = op(async (id: string) => {
  return db.users.findUnique({ where: { id } });
});

// only one DB call is made
const [a, b] = await Promise.all([getUser("abc"), getUser("abc")]);
```

### Options

```ts
op(fn, {
  name: "getUser",         // label for log output
  ttl: 60_000,             // LRU cache TTL in ms (no cache without this)
  maxItems: 1000,          // max LRU entries (default: 1000)
  retries: [100, 500],     // retry delays in ms
  retryAfter: true,        // honor a retry-after / x-ratelimit-reset header on retries
                           // (true = built-in reader, or a (err) => number | undefined)
  retryAfterCap: 20_000,   // cap (ms) on a honored retry-after hint (default: 20000)
  bail: (err) => boolean,  // return true to abort retries immediately
  skipCache: (result) => boolean, // return true to skip caching this result
  cacheHit: (key) => {},   // called on cache hit (null to silence)
  cacheMiss: (key) => {},  // called on cache miss (null to silence)
});
```

### Cache control

Every `op` function gets `clear`, `has`, and `invalidate` methods:

```ts
const getRepo = op(async (input: { org: string; repo: string }) => {
  return github.repos.get(input);
}, { ttl: 60_000 });

getRepo.has({ org: "acme", repo: "app" });    // => boolean
getRepo.clear({ org: "acme", repo: "app" });  // clear one key
getRepo.clear();                               // clear all

// predicate-based eviction
getRepo.invalidate((key) => key.org === "acme"); // => number removed
```

### Cache keys

The first argument is used as the cache key. Strings pass through directly; objects are hashed with [`object-hash`](https://github.com/puleos/object-hash) (order-independent):

```ts
await getRepo({ org: "acme", repo: "app" });
await getRepo({ repo: "app", org: "acme" }); // cache hit - same hash
```

`null` cache keys throw. `undefined` maps to a shared sentinel (`VOID_KEY`), so zero-arg ops can be wrapped purely for retry/dedup semantics - all no-arg invocations share one cache slot.

### Context parameter

If your function accepts a second argument, it's treated as a **context** parameter - passed through to the function but **not** included in the cache key:

```ts
const getRepo = op(async (id: string, ctx: { token: string }) => {
  return github.repos.get({ id, token: ctx.token });
}, { ttl: 60_000 });

await getRepo("123", { token: "abc" }); // executes
await getRepo("123", { token: "xyz" }); // cache hit (ctx ignored)
```

### Retries

Pass an array of delay values in ms. The function will retry up to `retries.length` times:

```ts
const getUser = op(async (id: string) => {
  return api.getUser(id);
}, {
  retries: [100, 500, 2000],
});
```

Use `bail` to abort retries early on non-transient errors:

```ts
const getUser = op(async (id: string) => {
  return api.getUser(id);
}, {
  retries: [100, 500, 2000],
  bail: (err) => err instanceof NotFoundError,
});
```

### Object form with Standard Schema validation

The object form accepts optional `input` and `output` schemas conforming to the [Standard Schema](https://github.com/standard-schema/standard-schema) spec (Zod, Valibot, ArkType, etc.):

```ts
import { z } from "zod";

const getUser = op({
  input: z.string(),
  output: z.object({ id: z.string(), name: z.string() }),
  run: async (id) => {
    return db.users.findUnique({ where: { id } });
  },
  ttl: 60_000,
  retries: [100, 500],
});
```

Input is validated before `run` is called. Output is validated before the result is returned. All `OpOptions` (`ttl`, `retries`, `name`, etc.) work the same way.

The object form also supports a `ctx` parameter on `run`:

```ts
const getUser = op({
  input: z.string(),
  run: async (id, ctx: { requestId: string }) => {
    return { id, requestId: ctx.requestId };
  },
});

await getUser("abc", { requestId: "req-1" });
```

### Null/undefined results

`null` and `undefined` return values are never cached, even when `ttl` is set.

## `schedule`

Build an array of retry delays from a formula:

```ts
import { schedule } from "polaris/yes";

schedule((i) => 100 * 2 ** i, 4);
// => [100, 200, 400, 800]

schedule((i) => (i + 1) * 500, 3);
// => [500, 1000, 1500]
```

Designed to plug directly into `retries`:

```ts
const getUser = op(async (id: string) => api.getUser(id), {
  retries: schedule((i) => 100 * 2 ** i, 4),
});
```

## `range`

Small array helper with three overloads:

```ts
import { range } from "polaris/yes";

range(5);           // => [0, 1, 2, 3, 4]
range(1, 5);        // => [1, 2, 3, 4, 5]
range(4, (i) => i ** 2); // => [0, 1, 4, 9]
```
