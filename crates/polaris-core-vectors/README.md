# polaris-core-vectors

Golden vectors for `polaris-core` (see `docs/rust-core-plan.md`, section 4.1).
One file per operation, `<domain>/<op>.json`, written by running the current
TypeScript implementation (`npm run vectors -w @polaris/core-rs`) and replayed
unchanged by native Rust, the Node binding and the WebAssembly binding. Files
are committed; regenerating them is a reviewed change, and a test fails when
the committed files no longer match what the TypeScript code produces.

```json
{
  "domain": "probe",
  "op": "decodeHex",
  "source": "dashboard/packages/core-rs/src/domains/probe/ts.ts",
  "cases": [
    { "name": "mixed case", "args": ["00ffAb"], "expect": { "ok": { "$bytes": "00ffab" } } },
    { "name": "odd length", "args": ["abc"], "expect": { "error": { "kind": "RangeError", "message": "Invalid hex string: odd length" } } }
  ]
}
```

Values are plain JSON except for three tagged objects, each the only key of
its object:

| Tag | Meaning |
|---|---|
| `{"$bytes": "<lowercase hex>"}` | a `Uint8Array` / `Vec<u8>` |
| `{"$utf16": [<code units>]}` | a string JSON cannot carry: it holds an unpaired surrogate |
| `{"$repeat": {"text": "<s>", "times": <n>}}` | `s` repeated `n` times, so huge inputs stay small on disk |

The loader rejects an unknown tag, a malformed tag body, an empty case list
and a case that expects both a value and an error: a broken file never turns
into a test that checks nothing.
