/**
 * What Polaris adds to the browser's own right-click menu: the vault's entries
 * on a box you can type into, and Polar's on a selection, a link, an image or
 * the page itself.
 *
 * Pure, so which entries a box gets can be asserted without a browser. The
 * worker creates the entries and does what they say; the page's script tells it
 * what kind of box the pointer is over, so the menu that opens fits the box.
 *
 * The browser's menu cannot ask what kind of box was clicked - "editable" is as
 * narrow as it goes - so the kind is reported as the pointer arrives over a box,
 * well before the right-click. Where the page's script is not running (a site
 * switched off, a page it cannot reach), nothing is reported and every entry
 * stays: one that does not fit is a click that types nothing, never one that
 * types the wrong thing somewhere.
 */

import { ENGLISH, type Words } from "@/lib/words";
import type { PolarAsk } from "@/lib/polar-panel";

/** The ids the entries are created and answered under. */
export const MENU = {
    root: "polaris",
    fill: "polaris-fill",
    code: "polaris-code",
    email: "polaris-email",
    generate: "polaris-generate"
} as const;

export type MenuId = (typeof MENU)[keyof typeof MENU];

/** One entry under Polaris, in the order they are listed. */
export interface MenuEntry {
    readonly id: Exclude<MenuId, typeof MENU.root>;
    readonly title: string;
}

/** The entries, titled in the reader's words. */
export function menuEntries(t: Words = ENGLISH): readonly MenuEntry[] {
    return [
        { id: MENU.fill, title: t("menu.fill") },
        { id: MENU.generate, title: t("menu.generate") },
        { id: MENU.code, title: t("menu.code") },
        { id: MENU.email, title: t("menu.email") }
    ];
}

/** The entries in English, for whatever reads them without a reader. */
export const MENU_ENTRIES: readonly MenuEntry[] = menuEntries();

/** The kind of box the pointer is over, as the page's script reads it. */
export type MenuTarget = "password" | "text";

/**
 * Which entries show for a box.
 *
 * A password box gets the login and a new password; any other box the login,
 * the code and your email. The login is on both because either box is where a
 * sign-in starts.
 */
export function visibleEntries(target: MenuTarget): Record<MenuEntry["id"], boolean> {
    const password = target === "password";
    return {
        [MENU.fill]: true,
        [MENU.generate]: password,
        [MENU.code]: !password,
        [MENU.email]: !password
    };
}

/** Where the browser's menu shows Polaris at all: every context an entry has. */
export const ROOT_CONTEXTS = ["editable", "selection", "link", "image", "page"] as const;

/** The ids Polar's entries are created and answered under. */
export const POLAR_MENU = {
    selection: "polaris-polar-selection",
    explain: "polaris-polar-explain",
    summarize: "polaris-polar-summarize",
    translate: "polaris-polar-translate",
    link: "polaris-polar-link",
    image: "polaris-polar-image",
    page: "polaris-polar-page"
} as const;

export type PolarMenuId = (typeof POLAR_MENU)[keyof typeof POLAR_MENU];

export type PolarContext = "selection" | "link" | "image" | "page";

/** One of Polar's entries: its title and the one context it shows in. */
export interface PolarMenuEntry {
    readonly id: PolarMenuId;
    readonly title: string;
    readonly context: PolarContext;
}

/**
 * Polar's entries, titled in the reader's words. Each one puts what was
 * clicked into Polar's composer, with a question already typed, and stops
 * there: nothing is sent until the person sends it.
 */
export function polarMenuEntries(t: Words = ENGLISH): readonly PolarMenuEntry[] {
    return [
        { id: POLAR_MENU.selection, title: t("menu.polar.selection"), context: "selection" },
        { id: POLAR_MENU.explain, title: t("menu.polar.explain"), context: "selection" },
        { id: POLAR_MENU.summarize, title: t("menu.polar.summarize"), context: "selection" },
        { id: POLAR_MENU.translate, title: t("menu.polar.translate"), context: "selection" },
        { id: POLAR_MENU.link, title: t("menu.polar.link"), context: "link" },
        { id: POLAR_MENU.image, title: t("menu.polar.image"), context: "image" },
        { id: POLAR_MENU.page, title: t("menu.polar.page"), context: "page" }
    ];
}

export const POLAR_MENU_ENTRIES: readonly PolarMenuEntry[] = polarMenuEntries();

/** Whether a clicked entry is one of Polar's. */
export function isPolarEntry(id: string | number): id is PolarMenuId {
    return POLAR_MENU_ENTRIES.some((entry) => entry.id === id);
}

/** What the browser says was under the pointer, as far as an entry reads it. */
export interface MenuClick {
    readonly selectionText?: string;
    readonly linkUrl?: string;
    readonly srcUrl?: string;
    readonly pageUrl?: string;
}

const webAddress = (value: string | undefined): string | undefined =>
    value && /^https?:\/\//i.test(value) ? value.slice(0, 2048) : undefined;

/**
 * What an entry asks Polar. The selection goes in as a quote; a link, an image
 * or the page as its address in the question, because Polar reads text and an
 * address is what the browser hands over - nothing is fetched here. Null for
 * a click with nothing to ask about.
 */
export function polarAskFor(id: PolarMenuId, click: MenuClick, t: Words = ENGLISH): PolarAsk | null {
    const selection = click.selectionText?.trim();
    switch (id) {
        case POLAR_MENU.selection:
            return selection ? { quote: selection } : null;
        case POLAR_MENU.explain:
            return selection ? { quote: selection, draft: t("menu.polar.explainDraft") } : null;
        case POLAR_MENU.summarize:
            return selection ? { quote: selection, draft: t("menu.polar.summarizeDraft") } : null;
        case POLAR_MENU.translate:
            return selection ? { quote: selection, draft: t("menu.polar.translateDraft") } : null;
        case POLAR_MENU.link: {
            const url = webAddress(click.linkUrl);
            return url ? { draft: t("menu.polar.linkDraft", { url }) } : null;
        }
        case POLAR_MENU.image: {
            const url = webAddress(click.srcUrl);
            return url ? { draft: t("menu.polar.imageDraft", { url }) } : null;
        }
        case POLAR_MENU.page: {
            const url = webAddress(click.pageUrl);
            return url ? { draft: t("menu.polar.pageDraft", { url }) } : null;
        }
    }
}
