# A TikTok card needed a second press to play

**Found:** October 2026. **Fixed in:**
`dashboard/apps/web/src/app/(app)/chat/link-card.tsx`,
`dashboard/apps/web/src/lib/chat/embeds.ts`.
**Guarded by:** `dashboard/apps/web/test/chat/embeds.test.ts`,
`dashboard/apps/web/test/chat/link-card.test.tsx`.

## What was seen

Pressing play on a TikTok link card showed "Player error - please check your
network connection" inside the frame instead of the video, on a browser that
had never played a TikTok before. Pressing play again - on the same card, no
reload - played it. It looked like a flaky embed, and it was hard to catch in
testing because the second press that any repeated manual check makes is
exactly the one that always works.

## What it actually was

TikTok's player page itself sets a cookie on load, and the video it asks for
in that same load is answered with something that is not a video before that
cookie exists. Chrome blocks that answer (`ERR_BLOCKED_BY_ORB`), and the
player reports it through its own documented `onPlayerError` message rather
than loading anyway. The second load carries the cookie the first one just
set and plays normally. It happened with no sandbox on the iframe and on
TikTok's other embed address too, so it was TikTok's player, not anything
about how Polaris framed it.

Separately, the portrait card was capped at a fixed 20rem width but the video
inside it was narrower than that on most windows, so the card around an
upright video carried a visible strip of empty space a landscape card never
had.

## The fix

`link-card.tsx` listens for `message` events from the iframe's own
`contentWindow` while playing, and `playerFailed` in `embeds.ts` recognises
TikTok's `onPlayerError` shape and its two retryable codes - 2001 (TikTok
failed to serve the video) and 3001 (the video failed to play) - while
leaving a missing video (1001) or a refused autoplay (3002) alone, since
loading those again changes nothing. A recognised failure bumps `attempt`,
which is the iframe's React `key`, so a fresh element with the same address
loads in place of the stuck one - and only once, since the retry listener
only runs while `attempt` is still 0.

The card's own width now comes from `CARD_WIDTHS`, keyed by the same
`EmbedShape` the frame's aspect ratio already uses: a portrait card is sized
to the video itself (clamped to 70% of the viewport's height on a short
window) plus its padding and border, instead of a fixed cap wider than the
video it holds.

## What stops it coming back

`embeds.test.ts`'s "a player saying it could not play" suite asserts
`playerFailed` is true only for TikTok's own origin, its own message shape,
and its two retryable codes. `link-card.test.tsx`'s "a TikTok player that
could not play" suite asserts the card reloads once on that message and not
again on a second one, and ignores a message from another frame or another
site; its "an upright video's card" suite asserts the portrait card's width
tracks the video instead of a fixed landscape width.

## The general rule

A player embedded in an iframe can fail silently from the page's point of
view - no error event, no rejected promise - while still telling the frame
about it through whatever message channel its own SDK defines. Where a
provider's failure is transient and the provider's own documented protocol
names it, catching that message and reloading once is the fix; where it
isn't transient, reloading only hides a real failure behind one retry.
