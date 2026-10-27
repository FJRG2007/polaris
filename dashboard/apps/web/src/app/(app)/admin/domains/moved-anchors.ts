/**
 * Where each section that used to live on the single Domains page lives now.
 *
 * /admin/domains was one long page, and links into it were written with an anchor
 * - in notifications already stored, in bookmarks, in other screens. The sections
 * that moved to a page of their own are listed here so the Domains page can send
 * an old `#anchor` on to the page that holds it. Sections that stayed (the public
 * address, the DNS records) need no entry: the anchor still works where it is.
 */

export const DOMAINS_BASE = "/admin/domains";

export const MOVED_ANCHORS: Readonly<Record<string, string>> = {
    "backup-access": `${DOMAINS_BASE}/remote-access`,
    tailscale: `${DOMAINS_BASE}/remote-access`,
    "game-ports": `${DOMAINS_BASE}/ports`,
    "call-ports": `${DOMAINS_BASE}/ports`,
    "certificate-contact": `${DOMAINS_BASE}/certificates`,
    security: `${DOMAINS_BASE}/security`
};

/** The address an old Domains anchor now lives at, or null when it did not move. */
export function movedAnchorHref(hash: string): string | null {
    const id = hash.replace(/^#/, "");
    if (!Object.hasOwn(MOVED_ANCHORS, id)) return null;
    return `${MOVED_ANCHORS[id]}#${id}`;
}
