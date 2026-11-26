/**
 * Where the service, database and volume panels sit.
 *
 * On a computer each is a sheet pinned to the right edge, with a rounded,
 * bordered leading edge over the canvas behind it. On a phone there is no
 * canvas left to show beside it, so it is the whole screen: no border, no
 * rounding, edge to edge - a sheet's leading edge on a 375 px screen reads as
 * a panel that failed to open all the way.
 *
 * One string for the three, because the dialog primitive leaves a caller that
 * places itself (`translate-x-0`) alone on a phone, so the phone shape is this
 * file's to say and saying it three times is how one of them drifts.
 */
export const SIDE_PANEL =
    "right-0 left-auto top-0 flex h-full max-h-none translate-x-0 translate-y-0 flex-col bg-background rounded-none border-y-0 border-r-0 sm:rounded-l-xl max-sm:border-0 data-[state=open]:slide-in-from-right-4";
