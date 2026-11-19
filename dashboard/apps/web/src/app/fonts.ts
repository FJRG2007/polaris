/**
 * The faces every document Polaris draws is set in, declared once so the root
 * layout and the last-resort error boundary - which replaces that layout and its
 * `<html>` - put the same variables on the page. Without them the boundary fell
 * back to the system font.
 */

import localFont from "next/font/local";

/**
 * The typeface. Self-hosted rather than fetched from a font service: a build must
 * work with no network, and a request per visitor to a third party is a record of
 * who uses this instance held somewhere we do not control.
 *
 * IBM Plex Sans (and its mono companion for code, terminals and identifiers) is
 * drawn for interfaces that are read for hours - open counters, unambiguous
 * 1/l/I, a mono that lines up in a column. `swap` so text is readable before the
 * font lands, and the fallback is measured against the real face so the swap does
 * not reflow the page.
 */
const sans = localFont({
    src: [
        { path: "../fonts/IBMPlexSans-Regular.woff2", weight: "400", style: "normal" },
        { path: "../fonts/IBMPlexSans-Medium.woff2", weight: "500", style: "normal" },
        { path: "../fonts/IBMPlexSans-SemiBold.woff2", weight: "600", style: "normal" },
        { path: "../fonts/IBMPlexSans-Bold.woff2", weight: "700", style: "normal" }
    ],
    variable: "--font-plex-sans",
    display: "swap",
    adjustFontFallback: "Arial"
});

const mono = localFont({
    src: [
        { path: "../fonts/IBMPlexMono-Regular.woff2", weight: "400", style: "normal" },
        { path: "../fonts/IBMPlexMono-Medium.woff2", weight: "500", style: "normal" },
        { path: "../fonts/IBMPlexMono-SemiBold.woff2", weight: "600", style: "normal" }
    ],
    variable: "--font-plex-mono",
    display: "swap"
});

/**
 * The faces a display name can be set in.
 *
 * None of these is the interface font and none of them is ever used for one:
 * they exist so that somebody's name can look like theirs, in Chat, on a card,
 * in a member list. See `packages/core/src/profile-style.ts` for the catalogue
 * and `../fonts/NOTICE.md` for what each one is and who made it.
 *
 * `preload: false` on every one of them, and that is the whole design. A
 * declared face is not a downloaded face: the browser fetches it the first time
 * a glyph on the page is actually set in it, so a deployment where nobody has
 * chosen one pays for none of them, and the person who reads a channel where two
 * people have pays for two. Preloading them - the default - would be nine files
 * on the critical path of every page, for an ornament most accounts never turn
 * on.
 *
 * The single-weight display faces declare a range rather than 400. They have one
 * weight; naming it truthfully would let the browser synthesise a bold for the
 * effects that ask for one, which smears the outline sideways and reads as a
 * blurred name. A range says "this file covers those", so nothing is synthesised.
 */
const nameSerif = localFont({
    src: "../fonts/PlayfairDisplay-Bold.woff2",
    weight: "400 900",
    variable: "--font-name-serif",
    display: "swap",
    preload: false
});

const nameRounded = localFont({
    src: "../fonts/Fredoka-SemiBold.woff2",
    weight: "400 700",
    variable: "--font-name-rounded",
    display: "swap",
    preload: false
});

const nameHand = localFont({
    src: "../fonts/PlaypenSans-SemiBold.woff2",
    weight: "400 700",
    variable: "--font-name-hand",
    display: "swap",
    preload: false
});

const nameComic = localFont({
    src: "../fonts/Bangers-Regular.woff2",
    weight: "400 900",
    variable: "--font-name-comic",
    display: "swap",
    preload: false
});

const nameScript = localFont({
    src: "../fonts/Lobster-Regular.woff2",
    weight: "400 900",
    variable: "--font-name-script",
    display: "swap",
    preload: false
});

const nameBlock = localFont({
    src: "../fonts/Bungee-Regular.woff2",
    weight: "400 900",
    variable: "--font-name-block",
    display: "swap",
    preload: false
});

const nameBubble = localFont({
    src: "../fonts/RubikBubbles-Regular.woff2",
    weight: "400 900",
    variable: "--font-name-bubble",
    display: "swap",
    preload: false
});

const nameTechno = localFont({
    src: "../fonts/Orbitron-Bold.woff2",
    weight: "400 900",
    variable: "--font-name-techno",
    display: "swap",
    preload: false
});

const namePixel = localFont({
    src: "../fonts/PressStart2P-Regular.woff2",
    weight: "400 900",
    variable: "--font-name-pixel",
    display: "swap",
    preload: false
});

/** Every name face's variable class in one string, so adding a face is one line above and
 *  one entry here rather than a longer expression on the html element. */
const NAME_FACES = [
    nameSerif,
    nameRounded,
    nameHand,
    nameComic,
    nameScript,
    nameBlock,
    nameBubble,
    nameTechno,
    namePixel
]
    .map((face) => face.variable)
    .join(" ");

/** The variable classes of every face, for the `<html>` element. */
export const FONT_CLASSES = `${sans.variable} ${mono.variable} ${NAME_FACES}`;
