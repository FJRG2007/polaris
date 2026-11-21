/**
 * What a link preview may say about the thing behind a public link.
 *
 * A preview is fetched by a chat app's crawler, not by the person the link was
 * sent to: it carries no session, comes from a datacenter address, and its
 * answer is shown to everybody in the conversation. So the only links that may
 * name what they point at are the ones anybody holding the address could open
 * right now, from anywhere, with nothing else - no password, no account, no
 * allowlist, no address or region rule, no opening hours, and nothing that is
 * spent by being opened. Everything else gets the generic preview for its kind,
 * which is also exactly what an unknown token gets, so the preview never tells
 * a live token from a dead or made-up one.
 *
 * Pure: the caller reads the row (metadata columns only) and this decides.
 */

import { linkUsability, parseStringList, type LinkLimits } from "@/lib/link-guards";

/** Every kind of public address that draws its own preview. */
export const PREVIEW_KINDS = [
    "share",
    "transfer",
    "snippet",
    "fileRequest",
    "textRequest",
    "note",
    "task",
    "document",
    "form",
    "meeting",
    "chat",
    "analytics",
    "send",
    "places",
    "profile",
    "org",
    "calendar",
    "status"
] as const;

export type PreviewKind = (typeof PREVIEW_KINDS)[number];

export function isPreviewKind(value: string): value is PreviewKind {
    return (PREVIEW_KINDS as readonly string[]).includes(value);
}

/** Kinds whose content never leaves the browser that holds the key, or whose
 *  address opens something physical: their preview is the kind, always. */
const NEVER_DISCLOSED: ReadonlySet<PreviewKind> = new Set(["send", "places", "calendar", "status"]);

/** A link row, reduced to what decides whether its preview may name it. Every
 *  field but `limits` is optional so a table without a rule reads as "none". */
export interface PreviewLinkState {
    limits: LinkLimits;
    passwordHash?: string | null;
    allowedCidrs?: string;
    allowedCountries?: string;
    allowedContinents?: string;
    requireLogin?: boolean;
    allowedUsers?: string;
    linkSchedule?: string | null;
    /** Spent on first open: burn after reading, a single-use cap. */
    oneTime?: boolean;
    /** Sealed in the sender's browser, or end-to-end encrypted. */
    sealed?: boolean;
    /** Turned off, unpublished, archived, trashed, or otherwise not served. */
    disabled?: boolean;
}

function hasEntries(json: string | undefined): boolean {
    return json ? parseStringList(json).length > 0 : false;
}

/**
 * Whether the preview may show the item's name and details. `null` is a token
 * that matched nothing, and answers the same as every refused state.
 */
export function mayDisclose(
    kind: PreviewKind,
    link: PreviewLinkState | null,
    now: Date = new Date()
): boolean {
    if (NEVER_DISCLOSED.has(kind) || !link) return false;
    if (link.disabled || link.sealed || link.oneTime) return false;
    if (link.passwordHash) return false;
    if (link.limits.maxUses !== null && link.limits.maxUses <= 1) return false;
    if (!linkUsability(link.limits, now).ok) return false;
    if (link.requireLogin || hasEntries(link.allowedUsers)) return false;
    if (hasEntries(link.allowedCidrs) || hasEntries(link.allowedCountries)) return false;
    if (hasEntries(link.allowedContinents)) return false;
    if (link.linkSchedule && link.linkSchedule.trim()) return false;
    return true;
}

/** What one preview shows: the kind always, a name and a detail only when allowed. */
export interface LinkPreview {
    kind: PreviewKind | null;
    title?: string;
    detail?: string;
}

/** The longest name a preview draws before it is cut. */
export const PREVIEW_TITLE_MAX = 80;

/**
 * Untrusted text made fit to draw: control characters and anything the bundled
 * face has no glyph for are dropped (a missing glyph would send the renderer out
 * to the network for a font, which this server may not have), whitespace is
 * collapsed, and the result is cut at `max` with an ASCII ellipsis. Returns
 * undefined when nothing readable is left.
 */
export function previewText(value: string | null | undefined, max = PREVIEW_TITLE_MAX) {
    if (!value) return undefined;
    const kept = value
        .replace(/[^ -~ -ſΆ-ώЀ-џ–—‘-„•…€]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!/[\p{L}\p{N}]/u.test(kept)) return undefined;
    return kept.length > max ? `${kept.slice(0, max - 3).trimEnd()}...` : kept;
}
