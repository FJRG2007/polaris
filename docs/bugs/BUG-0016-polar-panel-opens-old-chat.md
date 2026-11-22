---
id: BUG-0016
title: Polar's side panel still opens an old chat instead of a new one
status: fixed-watching
area: polar / side panel
location: dashboard/apps/web/src/lib/polar/open-chat.ts
related:
  - dashboard/apps/web/src/components/polar/polar-panel.tsx
  - dashboard/apps/web/src/components/polar/polar-open-settings.tsx
  - dashboard/apps/web/src/app/(embed)/polar/embed/polar-embed.tsx
  - docs/bugs/BUG-0007-polar-panel-reopens-on-empty-chat.md
reported: 2026-11-22
fixed: 2026-11-22
fix_commit: "fix(polar): opening Polar starts a new chat, and its settings say which one opens"
---

## What was seen

Opening Polar in the side panel showed an old conversation instead of a new
chat. The owner remembered a setting for choosing this but could not find it
in Polar's settings. Reported several times; BUG-0007 was the previous round.

## Why the earlier fixes did not hold

1. `e0745e2b29` (2026-10-25) made opening Polar start a new chat, with a
   "Reopen the last chat" switch (off by default). It also reopened the last
   chat whenever `reloaded()` said the page had been reloaded. That check
   answered once per page load, not "was Polar open when it reloaded", so the
   first opening after any reload brought the old chat back.
2. `8f471acd3e` (2026-11-19) made each tab remember its own chat in session
   storage, so a second window would not take over the panel's chat.
3. `38b594a657` (2026-11-21, BUG-0007) read the report "old chat, then an empty
   one" as the empty chat being the bug, and from then on always reopened the
   tab's own chat (session storage) when the panel opened again. That made
   the old chat permanent: within a tab, closing and opening the panel always
   brought back the last chat, whatever the setting said. The setting was
   left with nothing to change inside a tab, which is why it seemed missing.
4. The setting itself was the last of five switches in the "Chat display"
   card, labelled "Reopen the last chat", under a nav entry named "Chat
   display". Nothing in the name says it decides what opens.

In the browser extension, a panel set to "one chat per tab" always reopened
that tab's chat from local storage, so it never started new either.

## Root cause

There was no single rule for "Polar is being opened". The mount of
`PolarChat` mixed three signals (a scoped chat, a once-per-load reload flag
and the setting) and the BUG-0007 fix added a fourth (this tab's last chat)
that won over the setting.

## Fix

- `chatOnOpen` (`lib/polar/open-chat.ts`) is the one rule, used by every place
  Polar opens: the dashboard's side panel, the `/polar` page, the extension's
  panel (`/polar/embed`), and the desktop and mobile apps, which load the same
  pages. Opening Polar starts a new chat unless the person chose "The last
  chat". Two cases are not an opening and keep the chat on screen: the browser
  reloading the very view Polar was open in (the panel open when the page
  reloaded, or a reload of `/polar` itself), and the extension's per-tab panel
  moving between tabs while it stays open (session storage, which starts
  empty with each opening of the panel).
- The reload check now asks whether the panel was open at that reload
  (`PolarProvider` reads it as the page loads) or whether the reloaded address
  is `/polar` itself, instead of "the first chat since any reload".
- Polar's settings: the first section of the page now in the nav as "Opening
  and display" is "When Polar opens -> Start with: A new chat / The last
  chat". It is the existing `reopenLastChat` account preference (default
  false in code and in the database), so existing installs need nothing new
  and the extension and every device follow the same choice.
- Older chats are untouched and stay in the history.

No time-window option ("continue if used in the last N minutes"): none of the
products checked offers one.

## How other assistants do it

- Gemini in Chrome: the side panel starts a fresh chat each time; an earlier
  chat is moved in with one click.
  ([pasqualepillitteri.it](https://pasqualepillitteri.it/en/news/21970/gemini-chrome-reads-open-tab-by-default),
  [Digital Trends](https://x.com/DigitalTrends/status/2107208646652567595))
- Sider: resuming the last chat when the sidebar reopens is a feature with
  options, not the only behaviour
  ([Sider V4.5](https://sider.ai/whats-new/browser-extension/Sider-V4_5)).
- Monica, Merlin, MaxAI, HARPA: no public documentation of this behaviour or
  of a setting was found.

## Verified

- `test/polar/open-chat.test.tsx`: the rule for every case, and the setting
  shows "A new chat" by default, saves "The last chat" to the account and goes
  back when the server refuses.
- `test/polar/panel.test.tsx` ("opening Polar again"): a tab that was already
  in a chat opens on a new one with the setting off (fails before the fix);
  the tab's own chat comes back with "The last chat"; the first opening after
  a reload that found the panel closed is new.
- `test/polar/panel-reopen.test.tsx`: a reload with the panel open keeps the
  chat, and closing and opening it afterwards starts a new one; a reload with
  the panel closed opens on a new one.

## Not verified

- Not exercised in a real browser, the extension's side panel or the desktop
  app. That session storage starts empty with each opening of the extension's
  panel follows from the HTML storage rules and was not observed.

## If it happens again

Which surface (dashboard panel, extension, desktop), what "When Polar opens"
shows, whether the page had just been reloaded with the panel open, the
extension's "chat" scope (shared or per tab), and the values of
`polar.thread` in the tab's session storage and in local storage.
