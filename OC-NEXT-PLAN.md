# OpenCode parity - what is left on feat/polar-oc1

Done: OC2a logins (SuperGrok, GitHub Copilot, GitLab Duo on gitlab.com, Poe by key),
Zen stand-in audience (own-key people excluded unless `zenStandInEveryone`),
Copilot `/responses` routing, GitLab list held to its table,
login tokens renewed before a run/session gets them, OpenCode Console sign-in
with the Go allowance on the sign-in card.
OC8 local/cloud selector, self-managed GitLab. See the ledger rows OC1, OC2a and OC8.

Remaining, in order:

1. Copilot Enterprise (`company.ghe.com`): `oauthURLs`/`userURL`/`baseURL` by
   domain in `signin-copilot.ts`, a domain field in the dialog.

