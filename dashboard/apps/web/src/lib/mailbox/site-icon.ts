/**
 * The mark a site declares in its own page, for the sites that serve none at the
 * two addresses everybody used to.
 *
 * `/favicon.ico` and `/apple-touch-icon.png` are conventions, not rules, and a
 * modern site built as a single page application very often honours neither:
 * npm answers both with its own 404 page and names its logo in the document
 * head, on a static host that has nothing to do with `npmjs.com`. Asking only
 * the two well-known paths is why a mailbox full of names anybody would
 * recognise still showed initials.
 *
 * So the page itself is read, once, when the well-known paths have already
 * failed. Only the `<link>` elements are looked at - no parser, no dependency,
 * and nothing here follows anything a page says beyond the address of one
 * picture, which is fetched through the same guard as every other outbound
 * request.
 *
 * `mask-icon` is deliberately ignored: Safari's pinned-tab icon is a single-path
 * silhouette meant to be recoloured, so drawing it as a logo gives a black blob
 * where a mark should be.
 */

/** One icon a page names, with its address already made absolute. */
export interface IconLink {
    readonly href: string;
    /** The largest square edge it claims, or 0 when it claims none. */
    readonly size: number;
    /** Whether it is drawn as artwork rather than as a 16-pixel glyph, which is
     *  what an SVG or an unsized `icon` usually is. */
    readonly vector: boolean;
}

/** The size a mark is wanted at. A face is drawn at 28 CSS pixels and has to
 *  survive a doubled display, so anything around here is right and a 16-pixel
 *  favicon is the last resort rather than the first choice. */
const IDEAL = 128;

/** How many of a page's icons are worth trying. A site that names eight of them
 *  is a site whose best two will do; the rest are another server's afternoon. */
const KEEP = 3;

/** How much of a document is read. The head is at the top by definition, and a
 *  page that has not declared its icon in a quarter of a megabyte is a page
 *  whose sender gets initials. */
export const MAX_HTML_BYTES = 256 * 1024;

const LINK_TAG = /<link\b[^>]*>/gi;

/** One attribute off a tag, in any of the three ways markup writes one. */
function attribute(tag: string, name: string): string {
    const found = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(
        tag
    );
    return (found?.[2] ?? found?.[3] ?? found?.[4] ?? "").trim();
}

/** The biggest edge a `sizes` attribute claims. `any`, which is what an SVG
 *  usually says, claims none. */
function largestSize(sizes: string): number {
    let biggest = 0;
    for (const found of sizes.toLowerCase().matchAll(/(\d+)\s*x\s*(\d+)/g)) {
        biggest = Math.max(biggest, Number(found[1]), Number(found[2]));
    }
    return biggest;
}

/**
 * How far an icon is from the one that should be drawn.
 *
 * Closest to `IDEAL` wins, with two thumbs on the scale. A vector mark is worth
 * having whatever it claims to measure, because it is the same drawing at every
 * size - but it loses a tie to a raster one, since an SVG cannot carry its own
 * colours through a browser that is only allowed to treat it as a picture.
 */
function distance(link: IconLink): number {
    const size = link.size || (link.vector ? IDEAL : 32);
    return Math.abs(size - IDEAL) + (link.vector ? 1 : 0);
}

/**
 * Every icon a document names, best first.
 *
 * `base` is the address the document was finally served from, so a relative href
 * resolves against where the page actually is rather than where it was asked
 * for. Anything that will not resolve, or that resolves to something other than
 * a fetchable address, is dropped here rather than by the fetch.
 */
export function iconLinks(html: string, base: string): IconLink[] {
    // The head is where these live, and stopping there keeps a page that repeats
    // the word "link" ten thousand times in its body from being walked.
    const head = html.split(/<\/head\s*>/i)[0] ?? html;
    const found = new Map<string, IconLink>();

    for (const [tag] of head.matchAll(LINK_TAG)) {
        const rel = attribute(tag, "rel").toLowerCase().split(/\s+/);
        const apple =
            rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed");
        // `mask-icon` falls out here on its own: it is one token, and not the
        // one this is looking for.
        if (!apple && !rel.includes("icon")) continue;

        const href = attribute(tag, "href");
        if (!href) continue;
        let address: URL;
        try {
            address = new URL(href, base);
        } catch {
            continue;
        }
        if (address.protocol !== "http:" && address.protocol !== "https:") continue;

        const type = attribute(tag, "type").toLowerCase();
        const size = largestSize(attribute(tag, "sizes"));
        // An apple-touch-icon has one size whether it says so or not: the
        // convention is a 180-pixel square, which is exactly what is wanted.
        const link: IconLink = {
            href: address.href,
            size: size || (apple ? 180 : 0),
            vector: type.includes("svg") || address.pathname.toLowerCase().endsWith(".svg")
        };
        // A page that names the same file twice - once bare, once sized - is one
        // candidate, described best by whichever said the most.
        const held = found.get(link.href);
        if (!held || distance(link) < distance(held)) found.set(link.href, link);
    }

    return [...found.values()]
        .sort((left, right) => distance(left) - distance(right))
        .slice(0, KEEP);
}
