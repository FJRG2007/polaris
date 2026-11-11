/** Polar's settings pages, and where the addresses they replaced land. */

export const POLAR_SETTINGS_PATH = "/polar/settings";

/** Every settings page, in the order the sidebar lists them. Each is its own
 *  route under /polar/settings. */
/** In the order the sidebar groups them (`settings-sidebar.tsx`). */
export const POLAR_SETTINGS_SECTIONS = [
    "memory",
    "display",
    "extras",
    "tools",
    "connectors",
    "skills",
    "agents",
    "browser",
    "coding-tools",
    "routing",
    "usage",
    "permissions",
    "data"
] as const;

export type PolarSettingsSection = (typeof POLAR_SETTINGS_SECTIONS)[number];

/** The page a bare /polar/settings opens on. */
export const FIRST_SETTINGS_SECTION: PolarSettingsSection = "memory";

export function isSettingsSection(id: string | null | undefined): id is PolarSettingsSection {
    return !!id && (POLAR_SETTINGS_SECTIONS as readonly string[]).includes(id);
}

/** One settings page, by address. */
export function settingsSection(id: string): string {
    return `${POLAR_SETTINGS_PATH}/${id}`;
}

/** Set by the chat as it opens the settings: the address it was on, for their Back link. */
export const SETTINGS_FROM_CHAT_KEY = "polar.settingsFromChat";

/**
 * Where Back to chat goes: the address the chat was on, when it is a page of
 * this Polaris outside the settings, else Polar's own page. Going back in
 * history would land on the settings page visited before this one.
 */
export function chatReturnPath(stored: string | null): string {
    if (!stored || !stored.startsWith("/") || stored.startsWith("//") || stored.includes("\\"))
        return "/polar";
    const path = stored.split(/[?#]/)[0]!;
    if (path === POLAR_SETTINGS_PATH || path.startsWith(`${POLAR_SETTINGS_PATH}/`)) return "/polar";
    return stored;
}

/** Opens the settings from the chat, remembering the address the chat was on. */
export function openFromChat(push: (href: string) => void, section?: string): void {
    try {
        const { pathname, search, hash } = window.location;
        window.sessionStorage.setItem(SETTINGS_FROM_CHAT_KEY, `${pathname}${search}${hash}`);
    } catch {
        // Not remembered; Back goes to Polar's own page instead.
    }
    push(settingsSection(section ?? FIRST_SETTINGS_SECTION));
}
