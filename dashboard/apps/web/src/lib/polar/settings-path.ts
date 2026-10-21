/** Polar's settings page, and where the address it replaced lands. */

export const POLAR_SETTINGS_PATH = "/polar/settings";

/** Set by the chat as it opens the settings, so their Back link knows there is a chat to go back to. */
export const SETTINGS_FROM_CHAT_KEY = "polar.settingsFromChat";

/** Opens the settings from the chat, remembering that it was the chat that opened them. */
export function openFromChat(push: (href: string) => void, hash = ""): void {
    try {
        window.sessionStorage.setItem(SETTINGS_FROM_CHAT_KEY, "1");
    } catch {
        // Not remembered; Back goes to Polar's own page instead.
    }
    push(`${POLAR_SETTINGS_PATH}${hash}`);
}
