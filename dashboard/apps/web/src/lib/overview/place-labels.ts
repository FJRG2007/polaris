/**
 * Naming a page somebody visited.
 *
 * "Recently visited" is only useful if the entries are recognizable, and a path
 * is not: `/apps/deploy/0192f3a1-...` says nothing to the person who was just
 * looking at it. Three sources, in the order they are trusted:
 *
 *   1. The heading the page itself drew, which is the name of the thing - the
 *      project, the server, the space - and the only place it exists.
 *   2. The navigation registries, which name every fixed screen and are already
 *      what the rail and the search index are built from.
 *   3. The path, humanized, so a screen added without touching either of the
 *      above is still remembered as something rather than dropped.
 *
 * Pure and client-safe: it reads registries, never the DOM. The caller passes in
 * whatever heading it found.
 */

import { APP_SECTIONS, APP_SUBAPPS, POLARIS_APPS } from "@/lib/apps";

export interface PlaceLabel {
    label: string;
    /** The app or subject it sits in, for the second line. Null when the label
     *  already is the app. */
    context: string | null;
}

/** Screens that are never worth remembering: the Overview is where the card is
 *  drawn, and the account's own pages are one click from the avatar. */
const NEVER_RECORD = ["/overview"];

export function isRecordablePlace(pathname: string): boolean {
    return pathname.startsWith("/") && !NEVER_RECORD.includes(pathname);
}

/** Every fixed screen, longest path first so a nested one wins the prefix test. */
function registry(): { href: string; label: string; context: string | null }[] {
    const entries: { href: string; label: string; context: string | null }[] = [];
    for (const app of POLARIS_APPS) {
        const sections = APP_SECTIONS[app.id] ?? [];
        // An app whose landing page is one of its own sections is named by that
        // section, which says which app it belongs to. Keeping the app's own entry
        // would win the tie on an equal path and file everything under it as
        // "Apps" - the whole Deploy subtree included, since Apps lands there.
        if (!sections.some((section) => section.href === app.href)) {
            entries.push({ href: app.href, label: app.label, context: null });
        }
        for (const section of sections) {
            entries.push({ href: section.href, label: section.label, context: app.label });
        }
    }
    for (const subapp of APP_SUBAPPS) {
        for (const section of subapp.sections) {
            entries.push({ href: section.href, label: section.label, context: subapp.label });
        }
    }
    return entries.sort((left, right) => right.href.length - left.href.length);
}

// Built once: the registries are module constants, so this cannot go stale.
const ENTRIES = registry();

/** "drop-points" -> "Drop points". */
function humanize(segment: string): string {
    const words = decodeURIComponent(segment).replace(/[-_]+/g, " ").trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/** Whether a segment is an id rather than a name somebody would recognize. */
function isOpaque(segment: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment) || /^\d+$/.test(segment) || segment.length > 24;
}

/**
 * What to file a visit under.
 *
 * `heading` is the page's own h1 when it drew one. It wins for a screen that is
 * about one named thing, and is ignored when it only repeats the section name
 * the registry already knows - "Servers" under "Servers" is not a second line.
 */
export function describePlace(pathname: string, heading?: string | null): PlaceLabel {
    const known = ENTRIES.find((entry) => entry.href === pathname) ?? null;
    const nearest = known ?? ENTRIES.find((entry) => pathname.startsWith(`${entry.href}/`)) ?? null;
    const title = heading?.trim().slice(0, 120);
    // Where the page sits, written out: "Apps / Deploy".
    const within = nearest ? [nearest.context, nearest.label].filter(Boolean).join(" / ") : null;

    // A named thing inside a section reads as the thing, in the section. A
    // heading that only repeats the section's own name is not a second line.
    if (title && !(known && sameWords(title, known.label))) return { label: title, context: within };
    if (known) return { label: known.label, context: known.context };

    const last = pathname.split("/").filter(Boolean).at(-1) ?? "";
    if (nearest) {
        return isOpaque(last)
            ? { label: nearest.label, context: nearest.context }
            : { label: humanize(last), context: within };
    }
    return { label: humanize(last) || "Polaris", context: null };
}

function sameWords(left: string, right: string): boolean {
    return left.trim().toLowerCase() === right.trim().toLowerCase();
}
