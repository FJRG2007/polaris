# AI provider marketplace - remaining steps

Done on `feat/ai-provider-marketplace` (see `git log`): Coarena seed row with its
endpoint exception, the `ModelProviderEntry` / `ModelProviderIndexState` store
(migration `20271120000070`), boot seeding (idempotent), models.dev refresh
through one bounded, ETag-aware, Zod-validated download (last good kept), the
custom-provider store functions, a DB-paged search, and all three readers
(run env `modelProviders()`, key probes `probeFor()`, Polar/OpenCode endpoints)
reading the snapshot of the store. Tests: `test/integrations/provider-catalog.test.ts`.

Remaining, in order (migrations 20271120000071..79 are free for these):

1. Async provider picker. `components/model-keys/provider-select.tsx` still takes
   a full `options` array, and `modelProviderRows()` (`lib/agents/model-key-providers.ts`)
   still builds it from the client-safe registry, which ships the seed table to
   the browser. Replace with a server action (`searchKeyProvidersAction`) over
   `searchProviderCatalog` (query, kind, free, offset; take 24) returning
   `ProviderRow`-shaped hits (add apiKeyLabel/apiKeyHelp/createUrl/checkable via
   `catalogProvider` + registry for the builtin nine), debounced 200 ms, stale
   requests cancelled, "load more" at the list end, kind and free filter chips.
   `SearchableSelect` in `@polaris/ui` needs an async mode (controlled search
   text + onLoadMore) - check its props first. The keys table only needs names
   for rows it shows: have `loadModelProvidersAction` return
   `providerNames(keys.map(k => k.provider))` and drop the `providers` prop map.
2. Then remove `...SEEDED_MODEL_INTEGRATIONS` from `INTEGRATIONS` in
   `lib/integrations/registry.ts` (client bundle), and move the server readers
   of `MODEL_INTEGRATIONS` (`automations/code-review/actions.ts` MODEL_DEFAULTS,
   `model-key-providers.ts`, server `modelProviderName`) to the snapshot via
   `catalogIntegration()`. `findIntegration` in `admin/integrations/actions.ts`
   only serves non-model integrations; keep it. `logos.test.ts` "covers every
   entry" already passes names for Models.
3. Custom provider UI on `/admin/integrations/models`: an "Add provider" dialog
   (name, base URL, wire openai/anthropic via the design-system select, env var,
   default model, optional probe and docs URL), real-time validation against
   `customProviderSchema` (export the schema from a client-safe module), admin
   actions `addCustomProviderAction` / `removeCustomProviderAction` calling
   `addCustomProvider` / `removeCustomProvider` with `requireAdmin` and an audit
   record; refusal codes `taken`, `envTaken`, `invalid` -> i18n messages in
   `messages/en-US/admin.json` + `es-ES` (length rule). Removing one that has
   stored keys must say so in a dialog first.
4. Claude Code through Coarena: the row carries `anthropicBaseUrl`
   (`https://coarena.ai/api`). Wire it in the run env (`model-keys.ts`
   `applySecrets`) as `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` only when the
   session's chosen provider is an `anthropicBaseUrl` provider, never globally
   (it would redirect a person's own Anthropic key/sign-in).
5. Polar Chat model list for outside-index providers offers only the row's
   default model. Optionally read the provider's public `GET {baseUrl}/models`
   (Coarena answers keyless) into `AgentModel` on the daily refresh, bounded.
6. Coarena 429 `insufficient_quota` (resets 00:00 UTC): already classified as
   "credit" in `lib/polar/provider-failure.ts`, so the existing
   cooling/fallback applies; optionally cool until the next 00:00 UTC.
7. Admin screen line for the index state (`ModelProviderIndexState.lastError`,
   `refreshedAt`) beside the existing "Refresh catalogue" action.
