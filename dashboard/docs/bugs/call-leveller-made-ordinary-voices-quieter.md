# The call leveller made an ordinary voice quieter than it used to be

**Found:** October 2026. **Fixed in:**
`dashboard/apps/web/src/app/(app)/chat/mic-leveller.ts`.
**Guarded by:** `dashboard/apps/web/test/chat/mic-leveller.test.ts`.

## What was seen

After the mic leveller shipped - replacing a fixed makeup gain with one that
measures a voice and lifts it towards a target level - people on calls
reported that everybody sounded quieter than before, not louder. The feature
was built to help a badly-heard microphone, and the comment above its floor
said plainly that a voice would never go below what the noise model left it
at, which read as strictly no worse than before.

## What it actually was

That comment was true of the model's own output and false of what people
actually compared it against. The fixed makeup gain the leveller replaced
always added a flat 4 dB (`START_GAIN_DB`) to every voice, including one
already at a comfortable speaking level. The model itself still removes a
few decibels even from a voice that needs no help, and with the leveller's
floor (`MIN_GAIN_DB`) set to 0 dB - "never below what the model left" - there
was nothing stopping the gain from settling anywhere between 0 and the old 4
dB for a voice that was already loud enough. It did not go below the model's
own output; it went below the makeup that output used to get on top of.

Measured by playing a synthesised voice through the leveller the way
`filterMic` runs it (100 ms readings of a 2048-sample window): one at -14 to
-18 dBFS active level came out about 4 dB quieter than before, and one at
-22 dBFS about 2 dB quieter - exactly the range of an ordinary voice on a
decent microphone, which is why it read as "everybody", not one person's
setup.

## The fix

`MIN_GAIN_DB` is now `START_GAIN_DB` rather than `0`: the floor is the old
fixed makeup gain itself, not the model's raw output. The leveller can only
add to what a voice used to get, never take away from it - a quiet voice
still gets lifted further, up to `MAX_GAIN_DB` above the model's output, but
an ordinary one never drops below where the fixed stage always left it.

## What stops it coming back

`mic-leveller.test.ts`'s "what a voice goes out at, against the fixed makeup
it replaced" suite plays a synthesised voice at -14, -18 and -22 dBFS through
the same step-and-smooth path `filterMic` uses and asserts each comes out
within 0.5 dB of what the old fixed makeup gave it, while a quiet voice still
gets lifted further. The existing "never takes a loud voice below the makeup
it had before" case asserts `MIN_GAIN_DB` equals `START_GAIN_DB` directly.

## The general rule

"Never worse than the stage before this one" is only the right bound when
the stage before this one is the thing people are used to. Here the model
was two stages before the ear, with a fixed gain between them that had
always been there - so the floor needed to be measured against what that
whole chain produced before the change, not against the one stage closest to
it. A regression against "this value cannot go down" can still be a
regression against "the sound nobody noticed because it had always been
there."
