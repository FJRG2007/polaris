# Vendored runtime

This package is a clone, not a dependency. It was copied from an upstream
project and adapted; keeping the file layout means a future re-sync is a diff
rather than a rewrite.

- Commit taken: `f52e926a1c0f4a21374780274efcf087cbf07fbd`
- Taken: 2026-08-04
- Licence: MIT. `LICENSE` in this directory carries the copyright holder and
  the notice. That file is a licence obligation and has to stay.

Below, `<up>` stands for the upstream product token and `<UP>` for its uppercase
form. `LICENSE` is the one place the holder is named.

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

Mechanical and ordered most-specific first. Re-run the same table when
re-syncing: the literal tokens are visible in the tree being synced, so the
mapping below is enough to reapply it.

| Upstream | Here |
| --- | --- |
| the mascot-flavoured reviewer name | `reviewer` |
| `<up>-approval` | `polaris-agent-approval` |
| `RUN_STATUS_CHECK_NAME = "<up>"` | `"polaris-agent"` |
| `<up>.yml` / `.yaml` | `polaris-agent.yml` / `.yaml` |
| `<up>-api` (OIDC audience) | `polaris-agents` |
| the upstream repository slug | `polaris/agent-runtime` |
| `<UP>_*` env vars | `POLARIS_*` |
| `<up>` in any casing | `Polaris` / `polaris` |
| the progress placeholder constant and its string | `PROGRESS_PLACEHOLDER_PREFIX`, `"Working on it"` |

## Behavioural changes

Everything below is a deliberate departure, not drift.

- **Entrypoint.** Upstream's `entry.ts` was a bootstrap that re-launched the real
  CLI via `npx <package>@<version>` from the public registry. Polaris serves the
  bundle from the instance the run already authenticates against, so `entry.ts`
  calls `main()` directly. No registry fetch, no third party in the path.
- **Control plane.** `utils/apiUrl.ts` requires `POLARIS_API_URL` and has no
  default: there is no hosted service to fall back to. Every `/api/*` path the
  runtime asks for is re-rooted under `/api/agents` so it lands in the
  dashboard's namespace. The hosted-platform deployment-protection bypass was
  dropped.
- **Billing.** `utils/billingErrors.ts` kept its two error classes and lost the
  card, wallet, router and plan copy. Polaris holds no balance: the only refusals
  it can honestly report are a missing provider key and a provider out of credit.
- **Footer and comment copy.** Upstream's logo, its social and chat invite links,
  the hotlinked progress GIF and every documentation link were removed. The
  footer carries what a reader of the pull request can act on: where the run
  happened, what wrote it, which model.
- **Enigma.** `utils/enigma.ts` is ours, and `agents/claude.ts` and
  `agents/opencode.ts` each call `installEnigma` beside `installBundledSkills`.
  It installs the operator's policy skills, operating contract, slash commands
  and post-edit guardrails into the same fake HOME the bundled skills use, so a
  run works to the operator's standards whatever model is driving it. Gated on
  `settings.enigma` in the run context, which is a Polaris field: `RepoSettings`
  and `AgentRunContext` each gained one property for it, defaulting to null so an
  older control plane changes nothing. The install deliberately deletes Enigma's
  own `Stop` hook afterwards - this runtime's Stop hook owns the whole
  end-of-turn decision, and two hooks each deciding whether the agent may stop is
  a loop neither can see. Everything else Enigma writes composes: the skills are
  read-only guidance and the post-edit hooks run per edit and exit.
- **Why a run stopped.** Upstream treats a `session.error` as recoverable and
  reports only the harness's own terminal verdict. For one class that loses the
  reason: a provider refusing a request for exceeding the ACCOUNT's allowance is
  indistinguishable to the harness from one refused for size, so it compacts,
  is refused again, and stops saying the session was too large to compact. True,
  and it sends the reader after a bigger model for a limit the model never hit.
  `agents/opencode.ts` now keeps the last session error and folds it into that
  one verdict, and `utils/providerErrors.ts` grew
  `parseRequestTooLargeRefusal` so `utils/runErrorRenderer.ts` can quote the cap
  and say it belongs to the plan. Its context-overflow copy also stopped telling
  every run to split its pull request, since most are triggered by an issue.
  The rendered reason is then kept on `ToolState.failureBody` and PATCHed to the
  run row as `failure`, so the dashboard shows what the job summary shows -
  upstream reports the artefacts and the token counts, and Polaris is the side
  with a run row that would otherwise only be able to say that something failed.
- **Typography.** Em and en dashes were replaced with plain hyphens throughout
  (1208 occurrences), because this package writes prose into other people's
  repositories and that is the house rule for user-facing text.

## Style

The vendored files keep upstream's formatting (2-space indent, its own import
order) rather than Polaris's. Reformatting 38k lines would make every future
re-sync diff unreadable for no behavioural gain. Validation inside this package
is arktype, upstream's choice, for the same reason; every Polaris-side boundary
that talks to it uses Zod.
