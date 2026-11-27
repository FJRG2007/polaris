---
id: BUG-0073
title: Polar's answer shows control tags such as <final_answer> while it streams and once saved
status: fixed-watching
area: polar
location: dashboard/apps/web/src/lib/polar/control-tags.ts
related:
  - dashboard/apps/web/src/lib/polar/router/plan.ts
  - dashboard/apps/web/src/lib/polar/threads.ts
  - dashboard/apps/web/src/lib/polar/share.ts
  - dashboard/apps/web/src/lib/polar/export.ts
  - dashboard/apps/web/src/lib/polar/titles.ts
  - dashboard/apps/web/src/lib/polar/suggestions.ts
  - dashboard/apps/web/test/polar/control-tags.test.ts
reported: 2026-11-27
fixed: 2026-11-27
fix_commit:
---

## What was seen

Talking to Polar, the answer being written (and the preview of it) often showed
`<final_answer>` literally, and the saved answer kept it.

## Cause

Some models served through OpenCode Zen, OpenRouter and other OpenAI-compatible
endpoints write their control markup into the answer's text instead of the
provider's reasoning field: `<think>...</think>`, an answer wrapped in
`<final_answer>`/`<answer>`, chat-template tokens (`<|channel|>analysis<|message|>`,
`<|im_end|>`), or the bare `analysis...assistantfinal` left of the gpt-oss
harmony format when the server strips its special tokens. Nothing between the
provider stream and storage knew about any of it (the only handling was a
`<think>` regex in the draft rewriter), so it reached the stream, the stored
parts, previews, titles and suggestions as text.

## Fix

`control-tags.ts` is a streaming scanner, modelled on the AI SDK's
`extractReasoningMiddleware` (it holds back a tag split across chunks), that
knows all of the markup above: thinking becomes reasoning parts (shown as
Polar's thinking), answer wrappers and template tokens are dropped, unknown
tags are left alone, and nothing inside a fenced or inline code span is
touched. A thinking tag only opens at the start of a line, as in Open WebUI and
LibreChat. It runs as a language-model middleware on every planned step
(`router/plan.ts`), so the router, the stored answer, previews, titles and
suggestions all read clean text. Stored answers are cleaned on read
(`getPolarThread`, shared snapshots, exports) and stored titles too, so old
threads stop showing the tags.

## Verification

`test/polar/control-tags.test.ts`: every split point of tagged text, one
character at a time, harmony with and without tokens, fenced and inline code
kept, unknown tags kept, the stream part sequence, the middleware on both
generate and stream, and the read-side cleanup. Not seen rendered against a
live model.
