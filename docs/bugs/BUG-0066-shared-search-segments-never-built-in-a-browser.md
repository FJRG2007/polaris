---
id: BUG-0066
title: A browser never builds a shared search segment, and trusts the ones it reads
status: fixed-watching
area: chat
location: dashboard/apps/web/src/lib/chat/e2ee/device-across-tabs.ts
related:
  - dashboard/apps/web/src/lib/chat/e2ee/search-segments-client.ts
  - dashboard/apps/web/src/lib/chat/e2ee/sealed-chat.ts
  - dashboard/apps/web/src/lib/chat/e2ee/mls-client.ts
  - docs/chat-e2ee-mls.md
reported: 2026-11-27
fixed: 2026-11-27
fix_commit:
---

## What was seen

Found in review of row 10 ("Search on a new browser"), never on a deployment:
the feature is behind the sealed chat flag.

- A browser's segment build could never store a segment.
- A search hit opened at a newer version than its segment named was kept
  under the older edit time, so the launcher left it out.
- A reader opened every segment the server handed it without checking its
  signature.

## Cause

- **Promises for values.** The browser's MLS device is shared by every tab
  through a proxy (`device-across-tabs.ts`) that runs each call under a lock,
  so every call it does not list as immediate answers with a promise. The
  segment builder's `currentEpoch` and `signSearchSegment` are synchronous:
  it compared an epoch with a promise (so an ended epoch never counted as
  ended) and sent a promise as the signature, which the server refuses. The
  unit tests used a device without the proxy.
- **The ref's version.** `openSealed` kept what it opened under the version
  the caller named, not the one the server handed out; a segment built before
  an edit names the older one.
- **No check on the reader.** Only the server checked a segment's signature.

## Fix

- The three synchronous calls (`currentEpoch`, `memberSignatureKey`,
  `signSearchSegment`) answer at once through the proxy, with a test.
- `read-sealed` returns each row's `editedAt`, and search keeps the words,
  the device index entry and the opened content under it.
- The reader checks each segment's signature against the builder's leaf in
  its own copy of the group (`signedSegment`) and leaves out any that fail;
  where it holds no copy, against the device key the server registered.
