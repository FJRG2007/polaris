# Dependencies

How the dashboard's npm dependencies are kept patched, and the few places where
a known advisory is accepted instead of fixed.

## How a vulnerability is caught

- **On the pull request that changes dependencies.** Dashboard CI runs
  `npm audit --omit=dev` and `scripts/audit-gate.mjs`. A high or critical
  advisory in a production dependency fails the run unless
  `scripts/audit-allowlist.json` accepts it. On a pull request that touches no
  manifest, on a push and in the publish workflow the same check only reports:
  an advisory published today against a package nobody changed is not that
  change's fault. In that same non-gating case, `npm audit` or
  `audit-gate.mjs` itself failing to produce a usable report is a warning, not
  a failure - a broken check should not block a change it was never meant to
  gate.
- **Every Monday.** The maintenance workflow runs the same gate and the
  typecheck, and opens or updates one issue when either fails. Development-only
  and moderate findings are in its report and never open the issue on their own.
- **As updates.** Dependabot opens grouped pull requests weekly, and only the
  routine one is safe to read quickly: `minor-and-patch` (1.0 and later).
  Everything that needs a changelog read comes separately: `auth-and-security`
  (sign-in, sessions, keys, MCP, outbound fetch, sanitizing, database drivers),
  `framework` (Next and React together), `pre-1.0` (a 0.x minor may break; every
  0.x dependency must be listed, which `scripts/test/dependabot-groups.test.mjs`
  enforces), `major`, and GitHub Actions. Security updates arrive as soon as
  GitHub matches an advisory. None of them merges itself.
- **React is pinned once.** The root `overrides` point `react` and `react-dom`
  at the root's own devDependencies (`$react`), so a bump of those moves the
  whole tree instead of conflicting with a hard-coded override.

## Accepting an advisory

Only when there is no fixed release, or the fix needs a migration that is its
own project. Add an entry to `scripts/audit-allowlist.json`:

- `id`: the GHSA id, and `package`: the package npm reports it on.
- `reason`: why the vulnerable code cannot be reached from Polaris. "dev only"
  or "low risk" is not a reason; name the call path that is never taken.
- `expires`: at most three months out. An expired entry fails the gate again,
  so somebody looks at it with whatever has been released since.

The gate also lists acceptances whose advisory is no longer reported; delete
those.

Accepted today (until 2027-01-05):

| Advisory                                 | Package     | Why it stays                                                                                                                    | Goes away when                                                       |
| ---------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| GHSA-86w9-cpqp-85rv                      | node-forge  | No fixed release. acme-client uses forge for keys, CSRs and PEM, never RSA signature verification.                              | node-forge ships a fix, or acme-client drops forge.                  |
| GHSA-c475-qrg2-pj4r                      | basic-ftp   | No fixed release. Only on Puppeteer's browser download, which the bridge image skips.                                           | whatsapp-web.js moves to a Puppeteer without proxy-agent's FTP path. |
| GHSA-jmr9-qjv8-65gv, GHSA-7pqw-9j4j-h8q3 | extract-zip | No fixed release. Only unpacks Puppeteer's browser download, which the bridge image skips.                                      | Same as above.                                                       |
| GHSA-vfj7-8cjw-p6xm                      | braces      | No fixed release. Expands globs written in this repository (Tailwind 3 content paths, patch-package, sass's unused watch mode). | Tailwind 4 migration; patch-package replaced.                        |
| GHSA-6g55-p6wh-862q, GHSA-r28c-9q8g-f849 | postcss     | Next 15 pins 8.4.31; see Overrides. Build-time CSS of this repository's own stylesheets.                                        | Next 16.                                                             |
| GHSA-28wg-ghj8-5hjv                      | nanoid      | @univerjs/core 0.25 pins 5.1.11; every call passes a fixed positive size.                                                       | Univer 1.x, which drops nanoid.                                      |

## Overrides

`overrides` in `package.json` force a version on transitive dependencies. Each
one is a decision somebody has to undo later, so each is listed here.

| Override                     | Why                                                                                                                     | Remove when                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `esbuild: >=0.25.0`          | GHSA-67mh-4wv8-2f99: esbuild's dev server answered any origin before 0.25.0, and tsup and Vite pulled older copies.     | No dependency requests esbuild below 0.25.    |
| `postcss: ^8.5.29`           | GHSA-6g55-p6wh-862q, GHSA-r28c-9q8g-f849, GHSA-fxqj-rqcc-2cmp and the older `</style>` XSS: every postcss up to 8.5.22. | No dependency requests postcss below 8.5.29.  |
| `react`, `react-dom: $react` | One React in the whole tree: two copies break hooks at runtime. Follows the root devDependency.                         | Never, while this is a monorepo with one app. |

npm does not apply these to every node. The ones it skips today are Next's own
`postcss@8.4.31` and Univer's exact nanoid pin, which is why
those advisories are accepted above rather than overridden. Check with
`npm ls <package>` after changing an override: a node it reached shows
`overridden`.

## Packages from outside the npm registry

`xlsx` (SheetJS) stopped publishing to npm at 0.18.5, which carries a prototype
pollution and a ReDoS on crafted workbooks. `apps/web` installs 0.20.3 from
SheetJS's own CDN, the distribution SheetJS documents; the lockfile pins its
`integrity` hash, so a changed tarball fails `npm ci` instead of installing.

## Changing the lockfile

Regenerating `package-lock.json` on Windows has dropped the platform-specific
optional packages (`@next/swc-*`, `@esbuild/*`, `@rollup/*`, `@img/sharp-*`,
`@parcel/watcher-*`, ...) and broken Linux CI. So:

- Change it with the npm CI uses - npm 10, the one Node 22 ships
  (`npx npm@10 install --package-lock-only`, `npx npm@10 update <pkg>
--package-lock-only`) - starting from the committed lock, never by deleting
  it. npm 11 prunes optional peers npm 10 still requires (vitest's `sass` and
  its `@parcel/watcher-*` binaries), and `npm ci` in CI then fails.
- Before committing, compare the package paths of the old and new lock and make
  sure no platform variant disappeared unless its parent did.
- `npm ls --all --package-lock-only` must report nothing missing.
- Verify with a clean `npm ci`.
