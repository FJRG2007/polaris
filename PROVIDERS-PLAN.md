# AI provider marketplace - remaining steps

Done on `feat/ai-provider-marketplace` (see `git log`): steps 1-3 of the
original plan - async paged provider picker (`AsyncSelect` + kind / free
filters, `searchKeyProvidersAction`), seed table out of the client registry,
and the Add/Remove custom provider card on `/admin/integrations/models`
(migration `20271120000071`: `UserModelKey(provider)` index for the key count).

Remaining (migrations 20271120000072..79 free):

4. Claude Code through Coarena. In `session-runtime.ts` `modelEnvFor`, when
   `session.cli === "claude"` and `catalogProvider(choice.provider)?.anthropicBaseUrl`
   is set: take `chatCredentialFor(owner, provider, payer)` and return
   `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + `agentModelEnv`. In
   `credentialEnvFor`, when that applies, drop the cli's own credential envs
   (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN) so a person's Anthropic key is
   never sent to Coarena; add both new names to the `cleared` list in
   `refreshCredentials`. The Claude Code model picker must also offer Coarena
   models for a session to pick it (it lists Anthropic's only today).
5. Custom endpoint models in Polar Chat: in `refreshModelCatalog` (both the
   fresh and the 304 path) read `GET {baseUrl}/models` for `outsideIndex` rows
   (<= 50 providers, <= 200 models each, 1 MB cap, Zod `{data:[{id}]}`) through
   `configuredRequest(url, init, { allowPrivate: false })` (`lib/safe-fetch.ts`)
   into `AgentModel` (provider = slug); in `polar/models.ts` the `outsideIndex`
   branch lists `latestCatalogModels(slug, 100)` before the default model.
6. Coarena cool-down: `lib/polar/router/health.ts` `coolingMs` - for kind
   `credit` on a daily-quota provider (coarena) return ms until next 00:00 UTC.
7. Index state on admin: `providerIndexState()` exists in `provider-catalog.ts`;
   add it to `admin/agents/data.ts` and draw `refreshedAt` / `lastError` in
   `CatalogCard` (en-US + es-ES strings).
SSRF: Polar chat calls to `source === "custom"` endpoints (`polar/models.ts`
default branch) and key probes for custom rows (`provider-key-check.ts`
`probeKey`) still use plain fetch; pass a `fetch` built on `configuredRequest`
(allowPrivate false, long timeout for streams) to the AI SDK client and use it
in the probe.
