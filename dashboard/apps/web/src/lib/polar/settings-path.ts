/** Polar's settings pages, and where the addresses they replaced land. */

export const POLAR_SETTINGS_PATH = "/polar/settings";

/** Every settings page, in the order the sidebar lists them. Each is its own
 *  route under /polar/settings. */
export const POLAR_SETTINGS_SECTIONS = [
    "memory",
    "tools",
    "connectors",
    "skills",
    "permissions",
    "browser",
    "display",
    "extras",
    "routing",
    "coding-tools",
    "usage",
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

/** Set by the chat as it opens the settings, so their Back link knows there is a chat to go back to. */
export const SETTINGS_FROM_CHAT_KEY = "polar.settingsFromChat";

/** Opens the settings from the chat, remembering that it was the chat that opened them. */
export function openFromChat(push: (href: string) => void, section?: string): void {
    try {
        window.sessionStorage.setItem(SETTINGS_FROM_CHAT_KEY, "1");
    } catch {
        // Not remembered; Back goes to Polar's own page instead.
    }
    push(settingsSection(section ?? FIRST_SETTINGS_SECTION));
}
