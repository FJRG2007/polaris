/**
 * What the pointer was over when the message menu opened.
 *
 * A message is not one thing. It is a line of text with links written into it,
 * pictures under it and an embed beside it, and a right-click means something
 * different over each of them: "copy link" over a message is its address in
 * Polaris, and "copy link" over a link somebody wrote is that link. Offering
 * only the first is how a chat client ends up with no way at all to copy a URL
 * out of a message - the browser's own menu is gone, because the menu that
 * replaced it never asked what was underneath.
 *
 * So this reads the gesture: from whatever was actually clicked, walk up to the
 * message row and report the picture and the link it passed through, if any.
 * Both can be true at once - an embed's thumbnail is a picture inside a link -
 * and the menu draws whichever sections it is given.
 *
 * Pure and given the DOM rather than reading it, so the rules that matter can be
 * asserted: which schemes are worth copying, that a face is not one of the
 * message's pictures, and that an address inside Polaris is handed out on the
 * domain Polaris answers to rather than on whatever hostname this tab is using.
 */

/** A link that was written into the message, as the menu needs it. */
export interface LinkTarget {
    /** What lands on the clipboard. An outside address as written; one inside
     *  Polaris made absolute on the configured domain, since a copied link is
     *  for somebody else to open; an email without its scheme, because what
     *  somebody pastes is the address. */
    readonly copy: string;
    /** What opening it opens. Deliberately not `copy`: an address inside
     *  Polaris opens on this tab's own origin, which is the one hostname known
     *  to work from here. */
    readonly open: string;
    /** Which of the three it is, so the menu can say the right words. */
    readonly kind: "web" | "inside" | "email";
}

/** A picture that is part of the message. */
export interface ImageTarget {
    readonly url: string;
    /** What to call it when saving it. The alt text is the file's name for
     *  anything uploaded here; a written-in picture falls back to the last part
     *  of its address, and then to nothing worth reading. */
    readonly name: string;
}

export interface MessageTarget {
    readonly link: LinkTarget | null;
    readonly image: ImageTarget | null;
}

/** A right-click on the message itself and nothing in it. */
export const NOTHING: MessageTarget = { link: null, image: null };

/**
 * Read the gesture.
 *
 * `root` bounds the walk: the menu belongs to one message, and an element
 * outside it - which a portalled dialog or a stray target can be - is not part
 * of this message whatever it contains.
 */
export function messageTarget(
    from: Element | null,
    root: Element | null,
    baseUrl: string
): MessageTarget {
    if (!from || !root || !root.contains(from)) return NOTHING;

    const inside = (found: Element | null) => (found && root.contains(found) ? found : null);
    // A face is not one of the message's pictures. Pressing one opens the
    // person's photo, so the picture actions would half fit, and that is exactly
    // the kind of item somebody reaches for once and never trusts again.
    const image = from.closest("[data-avatar]") ? null : inside(from.closest("img"));
    const anchor = inside(from.closest("a[href]"));

    return {
        link: anchor ? linkOf(anchor.getAttribute("href"), baseUrl) : null,
        image: image ? imageOf(image) : null
    };
}

function imageOf(image: Element): ImageTarget | null {
    const url = image.getAttribute("src")?.trim() ?? "";
    if (!url) return null;
    const alt = image.getAttribute("alt")?.trim() ?? "";
    return { url, name: alt || nameIn(url) || "Image" };
}

/**
 * A link worth copying, or none.
 *
 * The same schemes the reader is allowed to click, for the same reason: the text
 * was written by somebody else, and `javascript:` on the clipboard is a link
 * that runs as whoever pastes it. Anything Polaris renders as an address of its
 * own - a mention, a task chip - is left out too. Those point at a person or a
 * record rather than at a page, and copying one hands over a string nothing else
 * in the world can open.
 */
function linkOf(href: string | null, baseUrl: string): LinkTarget | null {
    const value = href?.trim() ?? "";
    if (!value || value.startsWith("#")) return null;
    if (/^https?:\/\//i.test(value)) return { copy: value, open: value, kind: "web" };
    if (/^mailto:/i.test(value)) {
        return { copy: value.slice("mailto:".length), open: value, kind: "email" };
    }
    // Never protocol-relative: `//elsewhere.example` is a different site wearing
    // a leading slash, and it is not an address inside Polaris.
    if (value.startsWith("/") && !value.startsWith("//")) {
        return { copy: `${baseUrl}${value}`, open: value, kind: "inside" };
    }
    return null;
}

/** The last part of an address, when it looks like a file name. */
function nameIn(url: string): string {
    const path = url.split(/[?#]/)[0] ?? "";
    const last = path.split("/").filter(Boolean).pop() ?? "";
    if (!last.includes(".")) return "";
    try {
        return decodeURIComponent(last);
    } catch {
        return last;
    }
}
