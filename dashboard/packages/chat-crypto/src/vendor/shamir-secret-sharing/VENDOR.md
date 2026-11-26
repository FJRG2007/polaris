# Vendored: shamir-secret-sharing

- Package: `shamir-secret-sharing` (privy-io), independently audited (Cure53, Zellic)
- Version: 0.0.4
- Tarball: https://registry.npmjs.org/shamir-secret-sharing/-/shamir-secret-sharing-0.0.4.tgz
- Integrity: `sha512-ui8u/cIg2j16b9on/LH3V/glL6wHdwiTo/Iajzqx0STniBvuOzl6VYUxhrow3waF0dggovJfYiBZSWfTAN4XLQ==` (checked against the downloaded tarball)
- Source: https://github.com/privy-io/shamir-secret-sharing
- License: Apache-2.0 (`LICENSE`, copied from the tarball)
- Vendored: 2026-11-26

## Files

- `index.ts` - `src/index.ts` from the tarball.
- `csprng.ts` - `src/csprng.ts` from the tarball (the browser variant,
  `crypto.getRandomValues`, which Node 20+ also provides). The Node variant
  (`csprng.node.ts`, `node:crypto`) is not copied: this package runs in browsers.

## Changes from upstream

One line: in `index.ts`, `import {getRandomBytes} from 'shamir-secret-sharing/csprng'`
became `import {getRandomBytes} from './csprng'`. Nothing else is edited; the
upstream formatting is kept so a diff against the tarball stays one line.

## Updating

`npm view shamir-secret-sharing version dist.integrity dist.tarball`, `npm pack`
that version into an empty folder, check its sha512 against `dist.integrity`, read
the diff, copy `src/index.ts` and `src/csprng.ts` over these, re-apply the import
line and update this note. `test/shamir.test.ts` checks the field against FIPS 197
and every subset of a split.
