/**
 * The address behind a mention and behind a Polaris chip.
 *
 * Everything inserted with @ or #, and every link to this Polaris that somebody
 * pastes, is stored as one ordinary Markdown link pointing at a `polaris:`
 * address: `[@Ana Ruiz](polaris:user/0193...)`. Two things fall out of that.
 * The text stays readable and diffable outside Polaris, because the label is
 * still the link text; and the editor, the renderer and the server all have one
 * shape to recognize rather than a route table each.
 *
 * A pasted URL is folded into the same form when it points at something this
 * Polaris owns, which is what makes a pasted task link render as the task. A
 * link to anywhere else stays the link it was.
 */

/** What a reference can point at. */
export const REFERENCE_KINDS = [
    "user",
    "team",
    "task",
    "doc",
    "note",
    "channel",
    "message"
] as const;

export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/** The kinds @ offers: naming one of these tells somebody about it. */
export const MENTION_KINDS: readonly ReferenceKind[] = ["user", "team"];

export interface PolarisReference {
    readonly kind: ReferenceKind;
    readonly id: string;
    /** What is written between the brackets, and what a chip shows. */
    readonly label: string;
}

/** Ids are uuids. Anything else in the address is somebody else's link. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ADDRESS = /^polaris:(user|team|task|doc|note|channel|message)\/([0-9a-f-]{36})$/i;

/**
 * In-app paths a pasted link can carry, in the order they are tried.
 *
 * Order is load-bearing for the two chat ones: a message address is a
 * conversation address with the message on the end, so the conversation pattern
 * would swallow every message link if it were tried first.
 */
const ROUTES: readonly { readonly kind: ReferenceKind; readonly match: RegExp }[] = [
    // A message, which is identified by its own id alone - the conversation in
    // the address is where it happens to live, and the reader is told that by
    // whoever resolves it rather than by the link.
    { kind: "message", match: /^\/chat\/c\/[0-9a-f-]{36}\/([0-9a-f-]{36})/i },
    { kind: "channel", match: /^\/chat\/c\/([0-9a-f-]{36})/i },
    { kind: "task", match: /^\/tasks\/t\/([0-9a-f-]{36})/i },
    { kind: "doc", match: /^\/tasks\/docs\?(?:.*&)?doc=([0-9a-f-]{36})/i },
    { kind: "note", match: /^\/notes\?(?:.*&)?note=([0-9a-f-]{36})/i },
    // Where notes lived before they were an app of their own. Kept because the
    // links people already pasted into documents say this, and a paste that
    // stopped becoming a chip would be a silent regression.
    { kind: "note", match: /^\/account\/notes\?(?:.*&)?note=([0-9a-f-]{36})/i }
];

/** The stored target of a reference. */
export function referenceAddress(kind: ReferenceKind, id: string): string {
    return `polaris:${kind}/${id}`;
}

/** Reads a stored target back, or null when the link is an ordinary one. */
export function parseReferenceAddress(href: string): { kind: ReferenceKind; id: string } | null {
    const match = ADDRESS.exec(href.trim());
    if (!match || !ID.test(match[2]!)) return null;
    return { kind: match[1]!.toLowerCase() as ReferenceKind, id: match[2]!.toLowerCase() };
}

/**
 * Where a chip navigates to. People and teams have no screen of their own, so
 * their mention is a label rather than a link - which is also what stops a
 * mention from looking like somewhere to click and going nowhere.
 */
export function referenceHref(kind: ReferenceKind, id: string): string | null {
    if (kind === "task") return `/tasks/t/${id}`;
    if (kind === "doc") return `/tasks/docs?doc=${id}`;
    if (kind === "note") return `/notes?note=${id}`;
    if (kind === "channel") return `/chat/c/${id}`;
    // A message deliberately has none. Its address needs the conversation it
    // lives in, which this function is not given and which is not the link's to
    // assert anyway - whoever resolves the reference for a particular reader
    // says where it is, and only if that reader may go there.
    return null;
}

/**
 * The reference a pasted link resolves to, if it points at this Polaris.
 *
 * `origin` is the address this instance answers on, so a link copied out of the
 * browser bar matches as well as a path does. Anything under another host is
 * left alone: a link to somebody else's site is not a chip.
 */
export function referenceFromUrl(
    url: string,
    origin: string | null
): { kind: ReferenceKind; id: string } | null {
    let path = url.trim();
    if (/^https?:\/\//i.test(path)) {
        if (!origin) return null;
        let parsed: URL;
        let here: URL;
        try {
            parsed = new URL(path);
            here = new URL(origin);
        } catch {
            return null;
        }
        if (parsed.host !== here.host) return null;
        path = `${parsed.pathname}${parsed.search}`;
    }
    if (!path.startsWith("/")) return null;

    for (const route of ROUTES) {
        const match = route.match.exec(path);
        if (match && ID.test(match[1]!)) return { kind: route.kind, id: match[1]!.toLowerCase() };
    }
    return null;
}

/** The character that opens a mention of this kind, or "" for a plain chip.
 *  A conversation wears the `#` every client writes a channel with. */
export function referenceSigil(kind: ReferenceKind): string {
    if (kind === "channel") return "#";
    return MENTION_KINDS.includes(kind) ? "@" : "";
}

/** The kinds whose meaning is a fact about the reader rather than about the
 *  text: which conversation this is, whether they may see it, who is in it right
 *  now. Rendered from a resolution rather than from the label frozen into the
 *  link when somebody pasted it. */
export const RESOLVED_KINDS: readonly ReferenceKind[] = ["channel", "message"];
