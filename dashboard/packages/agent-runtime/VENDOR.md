# Vendored runtime

This package is a clone, not a dependency. It was copied from an upstream project
and adapted; keeping the file layout means a future re-sync is a diff rather than
a rewrite.

- Source: `pullfrog/pullfrog` (MIT)
- Commit: `f52e926a1c0f4a21374780274efcf087cbf07fbd`
- Taken: 2026-08-04

The MIT copyright notice is retained in `LICENSE` here and in the repository-root
`NOTICE`. That is a licence obligation and the only place the upstream name
appears; nothing a user of Polaris can see refers to it.

## What was taken

`agents/`, `mcp/`, `utils/`, `prep/`, `internal/`, `yes/`, `skills/`, and the
root modules (`main.ts`, `models.ts`, `modes.ts`, `effort.ts`, `lifecycle.ts`,
`toolState.ts`, `external.ts`, `config.ts`, `entryPost.ts`, `action.yml`).

## What was left behind

| Dropped | Why |
| --- | --- |
| `cli.ts`, `runCli.ts`, `commands/` | Upstream's developer CLI. Polaris drives runs from the dashboard, and the binaries carried the upstream name. |
| `get-installation-token/` | A second composite action. Polaris mints installation tokens server-side. |
| `test/`, `scripts/`, `play.ts`, `docker.ts`, `Dockerfile`, `lint/` | An end-to-end matrix harness needing live provider keys and a scratch repository, plus upstream release tooling. The colocated `*.test.ts` unit tests were kept. |
| `.github/`, `README.md`, `CONTRIBUTING.md` | Upstream project furniture. |

## Renames applied

Mechanical and ordered most-specific first, by `scratchpad/debrand.mjs`. Re-run
the same table when re-syncing.

| Upstream | Here |
| --- | --- |
| `reviewfrog` | `reviewer` |
| `pullfrog-approval` | `polaris-agent-approval` |
| `RUN_STATUS_CHECK_NAME = "pullfrog"` | `"polaris-agent"` |
| `pullfrog.yml` / `.yaml` | `polaris-agent.yml` / `.yaml` |
| `pullfrog-api` (OIDC audience) | `polaris-agents` |
| `pullfrog/pullfrog` | `polaris/agent-runtime` |
| `PULLFROG_*` env vars | `POLARIS_*` |
| `Pullfrog` / `pullfrog` | `Polaris` / `polaris` |
| `LEAPING_INTO_ACTION_PREFIX`, `"Leaping into action"` | `PROGRESS_PLACEHOLDER_PREFIX`, `"Working on it"` |

## Behavioural changes

Everything below is a deliberate departure, not drift.

- **Entrypoint.** Upstream's `entry.ts` was a bootstrap that re-launched the real
  CLI via `npx <package>@<version>` from the public registry. Polaris serves the
  bundle from the instance the run already authenticates against, so `entry.ts`
  calls `main()` directly. No npm fetch, no third party in the path.
- **Control plane.** `utils/apiUrl.ts` requires `POLARIS_API_URL` and has no
  default: there is no hosted service to fall back to. Every `/api/*` path the
  runtime asks for is re-rooted under `/api/agents` so it lands in the
  dashboard's namespace. The Vercel deployment-protection bypass was dropped.
- **Billing.** `utils/billingErrors.ts` kept its two error classes and lost the
  card, wallet, Router and plan copy. Polaris holds no balance: the only refusals
  it can honestly report are a missing provider key and a provider out of credit.
- **Footer and comment copy.** The mascot logo, the X link, the hotlinked
  progress GIF, the Discord invite and every `docs.` link were removed. The
  footer carries what a reader of the pull request can act on: where the run
  happened, what wrote it, which model.
- **Typography.** Em and en dashes were replaced with plain hyphens throughout
  (1208 occurrences), because this package writes prose into other people's
  repositories and that is the house rule for user-facing text.

## Style

The vendored files keep upstream's formatting (2-space indent, its own import
order) rather than Polaris's. Reformatting 38k lines would make every future
upstream diff unreadable for no behavioural gain. Validation inside this package
is arktype, upstream's choice, for the same reason; every Polaris-side boundary
that talks to it uses Zod.
