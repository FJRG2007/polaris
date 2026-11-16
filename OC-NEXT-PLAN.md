# OpenCode parity - what is left on feat/polar-oc1

Done: OC2a logins (SuperGrok, GitHub Copilot, GitLab Duo on gitlab.com, Poe by key),
Zen stand-in audience (own-key people excluded unless `zenStandInEveryone`).
See the ledger rows OC1 and OC2a.

Remaining, in order:

1. Copilot GPT-5 models that only answer on `/responses` are routed there, the
   way OpenCode does it (`pp/github-copilot.ts` in the clone).
2. Drop `duo-chat-gpt-5-3-codex` (and any other model GitLab's table lacks)
   from the GitLab list.
3. A session's login token is renewed before it is handed to the CLI.
4. OC2b - OpenCode Console sign-in (`pp/opencode.ts` in the clone): Console
   OAuth, service-account key, org via `x-org-id`, Go usage into
   `agent-usage-limits.ts`; store with the `provider-oauth.ts` shape on the
   `opencode`/`opencode-go` slugs and log in through `provider-logins.ts`.
5. OC8 - local/cloud selector (ledger section OC8).
6. GitLab self-managed: an instance URL + OAuth application ID pair on the
   login (the one value the operator enters is the application ID registered
   with redirect `http://127.0.0.1:8080/callback`, scope `api`); thread
   `metadata.instanceUrl/clientID` through `signin-gitlab.ts` (today constants).
7. Copilot Enterprise (`company.ghe.com`): `oauthURLs`/`userURL`/`baseURL` by
   domain in `signin-copilot.ts`, a domain field in the dialog.
