/**
 * The tab icon, and what is drawn onto it when something is waiting.
 *
 * A tab sitting behind another window is where a background alert has to be
 * noticed, and the bell is not on screen there - the icon is. So the same badge
 * the bell carries is drawn over the mark and swapped in as the tab's icon,
 * which is what makes a new alert visible without the tab being in front.
 *
 * What that badge says is the reader's choice - see `favicon-style`. A count is
 * the default because it answers "how much" without the page being opened; a
 * plain dot is the same thing a phone puts on an app icon, for anybody who wants
 * to be told that something happened and not how often.
 *
 * It is drawn rather than shipped as a set of pre-rendered images: the count
 * changes as alerts arrive and are read, so the icon has to be produced at the
 * moment it is shown. PNG rather than SVG because a favicon replaced from
 * script is only reliably picked up as a raster image across browsers.
 *
 * The mark below is the same geometry as the static app/icon.svg, which is what
 * the tab shows before any of this runs. A test holds the two together.
 */

/** The unit box the mark is drawn in. */
export const MARK_SIZE = 32;

/** Violet, matching the interface's primary. */
export const MARK_BACKGROUND = "#7632EC";

export const MARK_CORNER = 7;

/** A four-point star - Polaris is the one that does not move. */
export const MARK_STAR = "M16 3Q17.6 12.6 29 16Q17.6 19.4 16 29Q14.4 19.4 3 16Q14.4 12.6 16 3Z";

const MARK_FOREGROUND = "#FFFFFF";

/** Red, matching the interface's danger. */
const BADGE_BACKGROUND = "#E1474C";

/** Rendered at twice the largest size a browser asks for, so it stays sharp. */
const RENDER_SIZE = 64;

const BADGE_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** How much of the icon each badge takes, as a share of its width. */
const COUNT_RADIUS = 0.32;
const DOT_RADIUS = 0.2;

export interface FaviconLink {
    href: string;
    type: string;
}

/** What the mark is carrying. A count has to be read, a dot only has to be seen,
 *  and nothing at all is the third choice - which is `null` rather than a member
 *  here, because it is the absence of a badge and not a kind of one. */
export type FaviconBadge = { kind: "count"; label: string } | { kind: "dot" };

/**
 * The Polaris mark as a PNG data URL, carrying `badge` when there is one. Null
 * when the browser gives us no canvas to draw on, which leaves the icon already
 * in the document alone rather than blanking it.
 */
export function drawFavicon(badge: FaviconBadge | null, size = RENDER_SIZE): string | null {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return null;

    const scale = size / MARK_SIZE;
    context.save();
    context.scale(scale, scale);
    context.fillStyle = MARK_BACKGROUND;
    if (typeof context.roundRect === "function") {
        context.beginPath();
        context.roundRect(0, 0, MARK_SIZE, MARK_SIZE, MARK_CORNER);
        context.fill();
    } else {
        context.fillRect(0, 0, MARK_SIZE, MARK_SIZE);
    }
    context.fillStyle = MARK_FOREGROUND;
    context.fill(new Path2D(MARK_STAR));
    context.restore();
    if (!badge) return canvas.toDataURL("image/png");

    const dot = badge.kind === "dot";
    // A disc big enough to hold two digits, or the small one a phone puts on an
    // app icon - which has to stay small, or it stops reading as a mark on the
    // icon and starts reading as part of it.
    const radius = size * (dot ? DOT_RADIUS : COUNT_RADIUS);
    const x = size - radius;
    const y = radius;
    // A red disc straight on violet reads as one shape at 16px, so the mark is
    // cut away behind the badge and the gap separates them. The smaller the
    // disc, the wider that gap has to be in proportion to survive 16px.
    context.globalCompositeOperation = "destination-out";
    disc(context, x, y, radius * (dot ? 1.34 : 1.16));
    context.globalCompositeOperation = "source-over";
    context.fillStyle = BADGE_BACKGROUND;
    disc(context, x, y, radius);
    if (dot) return canvas.toDataURL("image/png");

    context.fillStyle = MARK_FOREGROUND;
    // The count is the first thing lost when a tab strip draws this at 16px, so
    // it is set as large as the disc holds and heavier than the interface would.
    context.font = `700 ${radius * (badge.label.length > 1 ? 1.1 : 1.5)}px ${BADGE_FONT}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(badge.label, x, y);
    return canvas.toDataURL("image/png");
}

/** What the tab is showing now, so the badge can be taken back off later. */
export function currentFavicon(): FaviconLink {
    const link = document.head.querySelector<HTMLLinkElement>("link[rel~='icon']");
    return {
        href: link?.getAttribute("href") ?? "/icon.svg",
        type: link?.getAttribute("type") ?? "image/svg+xml"
    };
}

/** Points the tab at `icon`, declaring one when the document has none. */
export function applyFavicon(icon: FaviconLink): void {
    const links = Array.from(document.head.querySelectorAll<HTMLLinkElement>("link[rel~='icon']"));
    if (links.length === 0) {
        const link = document.createElement("link");
        link.rel = "icon";
        document.head.appendChild(link);
        links.push(link);
    }
    // Browsers disagree about which icon link wins when a page declares several,
    // so every one of them is pointed at the same image; a sibling left behind
    // is exactly how a badge fails to show.
    for (const link of links) {
        link.type = icon.type;
        link.href = icon.href;
    }
}

function disc(context: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
}
