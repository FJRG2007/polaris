---
id: BUG-0004
title: Polar answers a mention with its tool call written out as text
status: fixed-watching
area: polar / chat mentions
location: dashboard/apps/web/src/lib/polar/mention-answer.ts
related:
  - dashboard/apps/web/src/lib/polar/automatic.ts
reported: 2026-11-21
fixed: 2026-11-21
fix_commit: "fix(polar): a tool call written out as text never reaches the conversation"
---

## What was seen

Asked in a group about game servers, Polar posted
`ernie:tool_call <invoke name="polaris_tools">...` as its answer.

## Cause (confirmed in code)

Some models answer with their own chat-template markup for a tool call when
the API does not parse it, so nothing ran and the markup came back as the
text. The Polar panel already caught this (`toolMarkupIn`) and kept the model
off turns with tools for a while (`noteToolMarkup`); the mention path only
stripped Polar's own `<polar_*>` tags, so the markup was posted.

## Fix

The mention path does what the panel does: the model is noted and the next one
is asked, and if none answers Polar says it could not answer. The markup is
never posted. While an answer streams, a tool call written as text is never
shown either (`mention-stream.ts`).

## Verified

- `test/polar/mention-answer-echo.test.ts`: an answer that is tool markup asks
  the next model, and is never the reply.
- `test/polar/mention-stream.test.ts`: the streamed draft never shows it.

## Not verified

- Which model answered the reported mention was not checked in the server's
  logs.

## If it happens again

From the dashboard's logs, the line `polar: ... answered by <provider>/<model>`
for that mention, and the text that was posted.
