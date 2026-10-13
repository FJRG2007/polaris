# A camera's own stream was stretched a third too tall

**Found:** October 2026. **Fixed in:**
`dashboard/apps/places/src/lib/player.ts`,
`dashboard/apps/places/src/lib/viewer-shape.ts`,
`dashboard/apps/places/src/screens/camera-tile.tsx`,
`dashboard/apps/places/src/screens/camera-viewer.tsx`.
**Guarded by:** `dashboard/apps/web/test/home/camera-viewer-shape.test.ts`,
`dashboard/apps/web/test/home/camera-viewer-resize.test.tsx`.

## What was seen

A camera's live view - in its tile, in the dialog, and in fullscreen - drew
every face and timestamp a third taller than they really are. The still shown
while the stream was loading looked right; the moment the live picture took
over, the same frame looked squashed.

## What it actually was

Some cameras (Tapo, over MSE) declare a pixel shape in their stream track that
does not match the picture they actually send: a 2304x1296 frame arrives
declared as if it were 2304x1728. `videoWidth` and `videoHeight` report
whatever shape the stream declares, not the shape of the pixels decoded, so a
box sized from them came out 4:3 for a 16:9 picture and the stream was then
drawn into it with `object-cover` (tile) or `object-contain` sizing the box
itself (viewer) - either way, the picture was stretched to the declared shape
rather than drawn at its own.

The still (decoded by the relay from the same camera, with square pixels) was
never wrong, which is what made the live switch-over so visible: the box
changed shape under a picture that had not.

## The fix

The shape now comes from the decoded frame's own visible area first
(`codedShape` in `player.ts`, via the WebCodecs `VideoFrame` API), then the
last still's shape, and the element's own `videoWidth`/`videoHeight` only when
neither is available (`streamShape` in `viewer-shape.ts`). The stream is drawn
at that measured shape with `object-fill` instead of letting the browser's
reported shape size or crop the box: `streamBox` and `coverBox` compute the
element's own box (viewer: as large as the dialog or screen allows, centred;
tile: covering the tile's shape and overhanging rather than squashing) from
the measured shape, not from `aspectRatio: auto`.

Because a `VideoFrame` can only be read once a frame has actually decoded,
`onLoadedData` (not `onLoadedMetadata`) is where the shape is first measured in
both the tile and the viewer; `onResize` keeps following it if the stream
changes resolution in-band. Where no frame can be read and no still is known
yet, the fix still has to fall back to the element's own report so an in-band
resize is not silently ignored (see `camera-viewer-resize.test.ts`) - that
report is simply the last choice, not the first.

## What stops it coming back

`camera-viewer-shape.test.ts` asserts `streamShape` prefers the decoded pixels
over a still, prefers a still over the element's report, and that `streamBox`
and `coverBox` draw the measured shape rather than the reported one.
`camera-viewer-resize.test.ts` asserts a stream that changes resolution
in-band is still followed once nothing more trustworthy (a decoded frame, a
still) is available to prefer instead.

## The general rule

A media element's own reported dimensions are not the shape of what it
decoded - they are the shape the stream declared, and a producer can declare
the wrong one. Where a more direct measurement of the decoded picture exists
(here, `VideoFrame`'s visible rect), prefer it over the element's report, and
keep the element's report only as the fallback for the case the direct
measurement cannot reach yet (before a frame has decoded).
