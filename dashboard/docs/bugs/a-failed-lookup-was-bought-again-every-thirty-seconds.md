# A failed lookup was bought again every thirty seconds

**Found:** November 2026. **Fixed in:**
`dashboard/apps/web/src/lib/integrations/provider-pause.ts`,
`dashboard/apps/web/src/lib/integrations/dymo.ts`,
`dashboard/apps/web/src/lib/integrations/virustotal.ts`,
`dashboard/apps/web/src/lib/integrations/criminalip.ts`,
`dashboard/apps/web/src/lib/waf-intel-service.ts`,
`dashboard/apps/web/src/lib/dymo-service.ts`,
`dashboard/apps/web/src/lib/address-reputation.ts`,
`dashboard/apps/web/src/lib/reputation-budget.ts`.
**Guarded by:** `dashboard/apps/web/test/access/metered-gate.test.ts`,
`dashboard/apps/web/test/access/provider-pause.test.ts`,
`dashboard/apps/web/test/access/reputation-lookups.test.ts`,
`dashboard/apps/web/test/mail/provider-answer.test.ts`.

## What was seen

The bill first. A reputation provider's account showed a request
count far beyond anything the instance's traffic could explain, and then every
request came back `402 Insufficient credits`. Inside Polaris nothing looked wrong:
no error on any screen, sites up, mail arriving. The firewall had simply stopped
banning anything by reputation, and nobody was looking at a number that had
dropped to zero.

## What it actually was

Three things that were each reasonable alone.

The firewall's sweep runs every thirty seconds and asks about up to twenty-five
addresses from the access log. An earlier fix had made it remember every answer,
which stopped the same bill once already. It did not remember failures, on purpose:
an outage is not a verdict.

A later change put a strict schema on the provider's answer, typing its flags as
booleans. A field that arrives as anything else makes the parse throw, after the
request has been made and paid for. To the sweep that is a failure, so nothing was
written down and the same addresses were bought again thirty seconds later, up to
tens of thousands of times a day. Which field it was could not be proved: by the
time this was looked at, the account could only answer `402`. What was proved is
that the last verdict and the last reputation ban date from the day that change
was deployed, after months of a steady rate.

The credits ran out, and the loop carried on through the refusals. Every caller
catches every error, because a reputation check must fail open, so nothing surfaced
anywhere. The SDK's own default of two retries multiplied any network or server
failure by three.

The lookup budget that would have capped all this already existed. Chat and the
network filter used it. The firewall, share links and the mail filter's Dymo
questions, the biggest callers, did not.

## How it was proved

The request was repeated once from the running dashboard with the stored key,
printing only the status: `402`, and rate-limit headers showing other requests in
the same minute. The cache table's newest row and the ban table's daily counts
stopped on the same day, and the network filter's verdict table was empty, which
ruled out the other background caller.

## What stops it coming back

- `whileServing` is the only way to a service billed per request. One failure
  pauses that provider for every caller: an hour for credits or a key, five minutes
  otherwise, then a single request to see if it is back. The pause is in the
  database, so an update does not restart the loop.
- It also holds a daily ceiling counted in the database, per request sent, with a
  conditional write so concurrent callers cannot lose a count. A process restarting
  in a loop cannot reset it, and reaching it stops the provider until midnight UTC
  and tells the operator.
- A VirusTotal scan polls three times instead of fifteen, each poll through the gate,
  and scans take at most three quarters of the budget, so uploads to a drop point
  cannot spend what the mail filter and chat need.
- `metered-gate.test.ts` calls every function each provider module exports against
  a service refusing with `402`, and fails if more than one request goes out. It
  also fails if the SDK or a provider's address appears in any other module.
- An operator is told, in the bell and on the integration's card, and the notice
  clears itself when the provider answers again.
- A flag from a third party is read by comparing it to `true`, so an unexpected
  value cannot turn a paid answer into a failure.
- The SDK's retries are off.
- The repository's `CLAUDE.md` carries the rule for the next provider.

## What a limit must not do

A drop point's link is public, so a budget is something a stranger can spend. A file
that arrives after that is kept but owed a scan: it is recorded as `pending`, a sweep
asks again once a minute, and the configured action still applies when the answer
comes. After a week the owner is told it could not be scanned. A failed request that
says nothing about the file (a 429, a 5xx, a timeout) leaves it owed the same way, and
the sweep sends nothing and reads nothing while the provider cannot answer. On a drop
point that overwrites, the file waits under its own name and only replaces the old one
once it is cleared, so unread bytes never stand in for a real document.


## What this does not cover

The list of providers is by hand. A new one that is never added to the gate is
caught by review and by that rule, not by a test.
