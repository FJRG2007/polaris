/**
 * What Polaris adds to the browser's own right-click menu on a box you can type
 * into.
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

export const MENU_ENTRIES: readonly MenuEntry[] = [
    { id: MENU.fill, title: "Fill the login for this site" },
    { id: MENU.generate, title: "Generate a password" },
    { id: MENU.code, title: "Fill the one-time code" },
    { id: MENU.email, title: "Fill my email" }
];

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
