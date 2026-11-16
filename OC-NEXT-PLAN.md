# OpenCode parity - what is left on feat/polar-oc1

Done: OC2a logins (SuperGrok, GitHub Copilot, GitLab Duo on gitlab.com, Poe by key),
Zen stand-in audience (own-key people excluded unless `zenStandInEveryone`),
Copilot `/responses` routing, GitLab list held to its table.
See the ledger rows OC1 and OC2a.

Remaining, in order:

1. A session's login token is renewed before it is handed to the CLI.
2. OC2b - OpenCode Console sign-in (`pp/opencode.ts` in the clone): Console
   OAuth, service-account key, org via `x-org-id`, Go usage into
   `agent-usage-limits.ts`; store with the `provider-oauth.ts` shape on the
   `opencode`/`opencode-go` slugs and log in through `provider-logins.ts`.
3. OC8 - local/cloud selector (ledger section OC8).
4. GitLab self-managed: an instance URL + OAuth application ID pair on the
   login (the one value the operator enters is the application ID registered
   with redirect `http://127.0.0.1:8080/callback`, scope `api`); thread
   `metadata.instanceUrl/clientID` through `signin-gitlab.ts` (today constants).
5. Copilot Enterprise (`company.ghe.com`): `oauthURLs`/`userURL`/`baseURL` by
   domain in `signin-copilot.ts`, a domain field in the dialog.
