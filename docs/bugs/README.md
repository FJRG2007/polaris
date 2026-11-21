# Bug ledger

Bugs that people reported from using Polaris, kept so a report that comes back
is matched to what was already found and changed instead of being diagnosed from
scratch. Each `BUG-*.md` says what was seen, the cause that was confirmed, what
was changed, what was and was not verified, and what to collect if it happens
again. A bug that returns after its fix is marked `regressed`, not filed again.

Security findings are not kept here; they live in
[`docs/vulnerabilities`](../vulnerabilities/README.md).

| ID | Title | Area | Status | Location | Reported |
|----|-------|------|--------|----------|----------|
| BUG-0001 | A shared screen goes out at low quality on a line that can carry the source | Calls | Fixed, watching | dashboard/apps/web/src/app/(app)/chat/call-quality.ts | 2026-11-21 |
| BUG-0002 | A conversation scrolls up into older messages on its own | Chat | Fixed, watching | dashboard/apps/web/src/app/(app)/chat/channel-view.tsx | 2026-11-21 |
| BUG-0003 | Polar's messages are named "somebody who has left", and its delete preview has no face or AI tag | Chat | Fixed, watching | dashboard/apps/web/src/lib/chat/author-name.ts | 2026-11-21 |
| BUG-0004 | Polar answers a mention with its tool call written out as text | Polar | Fixed, watching | dashboard/apps/web/src/lib/polar/mention-answer.ts | 2026-11-21 |
| BUG-0005 | Polaris desktop seems not to open on its first start, and again after a host is added | Desktop | Fixed, watching | desktop/src/main/window-front.ts | 2026-11-21 |
| BUG-0006 | Opening a link to another site in Polaris desktop ends the call | Calls | Fixed, watching | dashboard/apps/web/src/app/(app)/chat/use-sfu-call.ts | 2026-11-21 |
| BUG-0007 | Polar's side panel opens on the old chat, then on an empty one when opened again | Polar | Fixed, watching | dashboard/apps/web/src/components/polar/polar-panel.tsx | 2026-11-21 |
