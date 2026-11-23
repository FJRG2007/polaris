"use client";

/**
 * The sanitizer every message body goes through, in one place.
 *
 * Two callers need exactly the same pass: the reading pane, which draws the
 * result inside its sandboxed frame (see `message-body`), and the message store,
 * which keeps what was drawn so a message opened again paints at once. Kept
 * here so the two cannot drift - a store holding markup the pane would have
 * stripped is a store holding something nobody reviewed.
 *
 * DOMPurify is loaded on demand: it is the heaviest thing a conversation needs
 * and nothing before one opens does. `warmSanitizer` fetches it while the reader
 * is still looking at the list, so the first message somebody opens does not
 * wait on a script download it could have had for free.
 */

type Purify = typeof import("dompurify").default;

let loading: Promise<Purify> | null = null;

function purifier(): Promise<Purify> {
    loading ??= import("dompurify").then((module) => module.default);
    // A failed download is not kept: the next message tries again.
    loading.catch(() => {
        loading = null;
    });
    return loading;
}

/** Start loading the sanitizer now, and say nothing about how it went. */
export function warmSanitizer(): void {
    void purifier().catch(() => undefined);
}

/**
 * What a message's markup has already become, by the markup itself.
 *
 * A message opened, closed and opened again is the same string twice, and the
 * pass over a newsletter is a few milliseconds of main thread the second time
 * for nothing. Bounded, oldest first, for the same reason the message store is.
 */
const cleaned = new Map<string, string>();
const KEEP = 60;

/** The cleaned markup if this tab has already cleaned it, without waiting. */
export function cleanedAlready(html: string): string | null {
    return cleaned.get(html) ?? null;
}

/**
 * Strip everything a message must not carry into the page.
 *
 * Idempotent: cleaning what was already cleaned changes nothing, which is what
 * lets the store keep the cleaned copy and the pane clean it again regardless.
 */
export async function sanitizeMail(html: string): Promise<string> {
    const already = cleaned.get(html);
    if (already !== undefined) return already;
    const purify = await purifier();
    const base = messageBase(html);
    // The message's <base> is stripped - it would also redirect pictures and
    // the frame's own addresses - but what it says still decides where a
    // relative link goes, so those are resolved against it here, once.
    if (base) purify.addHook("afterSanitizeAttributes", (node) => resolveLink(node, base));
    let result: string;
    try {
        result = purify.sanitize(html, {
            // `data-remote-*` is how the server parks an address it held back. It
            // has to survive the sanitizer or "show pictures" has nothing to put
            // back.
            ADD_ATTR: [
                "target",
                "data-remote-src",
                "data-remote-srcset",
                "data-remote-background",
                "data-remote-poster"
            ],
            FORBID_TAGS: [
                "script",
                "iframe",
                "object",
                "embed",
                "form",
                "input",
                "button",
                "meta",
                "base"
            ],
            FORBID_ATTR: ["srcdoc", "formaction", "ping"],
            // Mail is full of tables and inline styles and always will be. They are
            // safe inside a frame with no same-origin and a policy that forbids
            // every outside load.
            ALLOW_DATA_ATTR: true
        });
    } finally {
        if (base) purify.removeHook("afterSanitizeAttributes");
    }
    cleaned.set(html, result);
    cleaned.set(result, result);
    while (cleaned.size > KEEP) {
        const oldest = cleaned.keys().next();
        if (oldest.done) break;
        cleaned.delete(oldest.value);
    }
    return result;
}

const XLINK = "http://www.w3.org/1999/xlink";

/**
 * The absolute web address a message's own `<base href>` names, or null. Only
 * http and https: a base is a place relative links are read against, never a
 * way to turn them into another scheme.
 */
export function messageBase(html: string): string | null {
    const found = /<base\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(html);
    const raw = (found?.[1] ?? found?.[2] ?? found?.[3] ?? "").trim();
    if (!raw) return null;
    try {
        const url = new URL(raw);
        return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch {
        return null;
    }
}

/** A link's relative address made absolute against the message's base. A
 *  fragment and an address with a scheme of its own are left as they are. */
function resolveLink(node: Element, base: string): void {
    const name = node.nodeName.toLowerCase();
    if (name !== "a" && name !== "area") return;
    const read = (raw: string | null): string | null => {
        const value = raw?.trim() ?? "";
        if (!value || value.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
        try {
            return new URL(value, base).href;
        } catch {
            return null;
        }
    };
    const plain = read(node.getAttribute("href"));
    if (plain) node.setAttribute("href", plain);
    const linked = read(node.getAttributeNS(XLINK, "href"));
    if (linked) node.setAttributeNS(XLINK, "xlink:href", linked);
}
