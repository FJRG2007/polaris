# OpenCode parity - what is left on feat/polar-oc1

Done: OC2a logins (SuperGrok, GitHub Copilot, GitLab Duo on gitlab.com, Poe by key)
- see the ledger row OC2a.

Remaining, in order:

1. Zen stand-in audience (coordinator decision): `endOnZen` in
   `apps/web/src/lib/polar/models.ts` adds Zen's free model to every plan. It must
   only do so for a person with no key of their own (`polarKeySources` empty for
   own keys), unless an admin opts everyone in. Add `zenStandInEveryone: boolean`
   (default false) to `polarPolicySchema` / `DEFAULT_POLAR_POLICY`
   (`lib/polar/access.ts`), surface it in `PolarAccess`, a switch beside the
   existing free-tier switch in `admin/agents/polar-access-card.tsx`, i18n
   en-US/es-ES admin.json, and gate `zenLastStep` on it. Test in
   `test/polar/providers/zen-stand-in.test.ts`.
2. GitLab self-managed: an instance URL + OAuth application ID pair on the
   login (the one value the operator enters is the application ID registered
   with redirect `http://127.0.0.1:8080/callback`, scope `api`); thread
   `metadata.instanceUrl/clientID` through `signin-gitlab.ts` (today constants).
3. Copilot Enterprise (`company.ghe.com`): `oauthURLs`/`userURL`/`baseURL` by
   domain in `signin-copilot.ts`, a domain field in the dialog.
4. OC2b - OpenCode Console sign-in (`pp/opencode.ts` in the clone): Console
   OAuth, service-account key, org via `x-org-id`, Go usage into
   `agent-usage-limits.ts`; store with the `provider-oauth.ts` shape on the
   `opencode`/`opencode-go` slugs and log in through `provider-logins.ts`.
5. OC8 - local/cloud selector (ledger section OC8).
