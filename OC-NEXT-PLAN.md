# OpenCode parity - what is left on feat/polar-oc1

Done: OC2a logins (SuperGrok, GitHub Copilot, GitLab Duo on gitlab.com, Poe by key),
Zen stand-in audience (own-key people excluded unless `zenStandInEveryone`),
Copilot `/responses` routing, GitLab list held to its table,
login tokens renewed before a run/session gets them.
See the ledger rows OC1 and OC2a.

Remaining, in order:

1. OC2b - OpenCode Console sign-in (`pp/opencode.ts` in the clone): Console
   OAuth, service-account key, org via `x-org-id`, Go usage into
   `agent-usage-limits.ts`; store with the `provider-oauth.ts` shape on the
   `opencode`/`opencode-go` slugs and log in through `provider-logins.ts`.
2. OC8 - local/cloud selector (ledger section OC8).
3. GitLab self-managed: an instance URL + OAuth application ID pair on the
   login (the one value the operator enters is the application ID registered
   with redirect `http://127.0.0.1:8080/callback`, scope `api`); thread
   `metadata.instanceUrl/clientID` through `signin-gitlab.ts` (today constants).
4. Copilot Enterprise (`company.ghe.com`): `oauthURLs`/`userURL`/`baseURL` by
   domain in `signin-copilot.ts`, a domain field in the dialog.

Notes for OC2b (read from the clone, `packages/core/src/plugin/provider/opencode.ts`
and `packages/core/src/console-access.ts`, `usage-limits.ts`):
- Server `https://opencode.ai/console`, client id `opencode-cli`. Device code:
  POST `{server}/auth/device/code` `{client_id, supports_org_scope: true}` ->
  `device_code, user_code, verification_uri_complete, expires_in, interval`.
  Poll POST `{server}/auth/device/token` `{grant_type:
  urn:ietf:params:oauth:grant-type:device_code, device_code, client_id}` (non-2xx
  allowed; `{error}` authorization_pending / slow_down +5 s). Token:
  `access_token, refresh_token, expires_in, org_id?`. Then GET `/api/user`
  `{id,email}` and `/api/orgs` `[{id,name}]` with the bearer; org = `org_id`'s
  or the first by name. Refresh: same token URL, `grant_type: refresh_token`;
  400 `invalid_grant` = signed out.
- Inference needs only the bearer (access token) - `languageModel`'s default
  branch already uses `credential.secret`, so a login row on `opencode` /
  `opencode-go` works once `unwrapLogin` renews it: add an `opencode` branch
  to `renew()` in `provider-login-refresh.ts`.
- Console API calls carry `x-org-id: <orgID>`; Go usage is GET
  `{origin}/zen/go/v1/usage` with the bearer and `x-opencode-org-id`, answer
  `{usage:{rolling,weekly,monthly:{status:"ok"|"rate-limited",percent,resetsAt}}}`,
  403 = no Go in that workspace. `agent-usage-limits.ts` holds admin limits,
  not provider meters - there is no subscription meter surface in Polaris
  yet, so the Go meter needs a new readout (decide where it shows).
- Tree state when this was written: items 1-4 of the batch committed; a full
  `vitest run test/agents test/polar` had not finished.
