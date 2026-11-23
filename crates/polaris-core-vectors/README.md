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

## Standard vectors (`mls/rfc9420/`)

The IETF MLS working group's interoperability vectors for RFC 9420, copied
unchanged from github.com/mlswg/mls-implementations (`test-vectors/`, commit
`2034fe72e0c805a683ba76165660c834f2a8142a`) and replayed by
`crates/polaris-core/tests/mls_rfc9420.rs`. They keep their own format, so
they sit one directory down, out of the golden-vector loader's way.

| File | SHA-256 |
|---|---|
| passive-client-welcome.json | `92ebb04b67b1aca4290965ae363650921842ceebe275bd79a2733414078d849c` |
| passive-client-handling-commit.json | `b24949fdf857bf79d511f57504a8bdc7ce3247eb199684745e439c11b1a1da21` |
| passive-client-random.json | `0095d863e9d316872e237fc708debcd20ba2687ee905a3e831f97dd3e578d3c1` |
