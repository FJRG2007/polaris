/**
 * A .pptx, read by the engine that understands one.
 *
 * Drive has shown PowerPoint files since long before this, through a parser
 * written here that reads a slide's shapes and paragraphs and lays them out with
 * absolute positioning. It is seven hundred lines and it is an approximation:
 * it has no theme inheritance, no layout or master chain, no gradient or picture
 * fills, no charts, no tables, no text measurement. A deck built from a template
 * - which is every deck anybody is given - draws in the wrong colours at the
 * wrong sizes, and the reader has no way to know that is what they are seeing.
 *
 * The real engine is in the repository and was not being used. `@polaris/pptx`
 * parses the package the way PowerPoint does, chain and all, and
 * `@polaris/pptx-render` turns a parsed slide into `RenderSlide` - plain data
 * describing exactly what to draw, with the geometry already resolved. That is
 * what this hands out.
 *
 * **It runs on the server, and that is not an accident.** Parsing a package
 * means unzipping it and walking a dozen XML parts per slide; doing that in the
 * tab is a second or two of blocked main thread on a large deck, on a machine
 * that may be a phone. The browser is handed the result, which is data, and
 * draws it.
 *
 * Fonts are measured heuristically rather than by loading each face and
 * measuring it. Exact metrics would need the fonts themselves on the server, and
 * the difference is a line of text a few pixels wide - visible only beside the
 * same deck in PowerPoint, and far smaller than the difference this replaces.
 */

import { openPptx, makeMediaResolver } from "@polaris/pptx";
import { buildRenderSlide, type RenderSlide } from "@polaris/pptx-render";

/** What a deck comes back as: one entry per page, in order. */
export interface RenderedDeck {
    readonly slides: readonly RenderSlide[];
}

/** The width the slides are built for. Geometry is resolved against it, so a
 *  deck is rebuilt rather than rescaled when the reader's width changes - which
 *  is why this is a parameter rather than a constant. */
export const DEFAULT_DECK_WIDTH = 1280;

/**
 * Parse a .pptx and build every page.
 *
 * Throws whatever the parser throws on a file that is not a presentation: the
 * caller decides what a reader is told, and it must not be this module's guess
 * at what went wrong.
 */
export async function renderPptxDeck(
    bytes: Uint8Array,
    fitWidthPx: number = DEFAULT_DECK_WIDTH
): Promise<RenderedDeck> {
    const opened = await openPptx(bytes);
    const slides: RenderSlide[] = [];
    for (const [index, slide] of opened.deck.slides.entries()) {
        slides.push(
            buildRenderSlide(slide, opened.deck.size, {
                fitWidthPx,
                // Resolved per page: a themed SVG takes its colours from the
                // chain of the slide it is on, and two pages can sit on
                // different layouts.
                media: makeMediaResolver(opened, slide.path),
                // One-based, and it has to be passed: a slide-number field
                // otherwise draws whatever was cached in the file, which is
                // stale the moment anybody reorders the deck.
                slideNo: index + 1
            })
        );
    }
    return { slides };
}
