/**
 * CalDAV services people pick by name instead of typing an address.
 *
 * Only ids and addresses live here; the words a screen shows for each come
 * from the app's message catalogs. `appPasswordHelp` is each provider's own
 * page on creating the app password its CalDAV needs - every one was opened and
 * checked to be that page. A provider without such a page has none.
 *
 * - iCloud needs an app-specific password (two-factor authentication on).
 * - Fastmail needs an app password whose access includes calendars (CalDAV).
 * - Yahoo needs an app password from its account security page.
 * - Nextcloud takes a device password from Personal settings, Security; the
 *   address is the person's own server followed by `/remote.php/dav`.
 */

export type CalDavPresetId = "icloud" | "fastmail" | "yahoo" | "nextcloud";

export interface CalDavPreset {
    readonly id: CalDavPresetId;
    /** The address discovery starts from; null when it is the person's own host. */
    readonly url: string | null;
    /** What goes after the person's own host, for self-hosted services. */
    readonly path: string | null;
    readonly appPasswordHelp: string | null;
}

export const CALDAV_PRESETS: readonly CalDavPreset[] = [
    { id: "icloud", url: "https://caldav.icloud.com", path: null, appPasswordHelp: "https://support.apple.com/en-us/102654" },
    { id: "fastmail", url: "https://caldav.fastmail.com/dav/", path: null, appPasswordHelp: "https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords" },
    { id: "yahoo", url: "https://caldav.calendar.yahoo.com", path: null, appPasswordHelp: "https://help.yahoo.com/kb/SLN15241.html" },
    { id: "nextcloud", url: null, path: "/remote.php/dav", appPasswordHelp: "https://docs.nextcloud.com/server/latest/user_manual/en/session_management.html" }
];

/** The address a preset starts discovery from, given the host a self-hosted one lives on. */
export function presetUrl(preset: CalDavPreset, host = ""): string {
    if (preset.url) return preset.url;
    const base = host.trim().replace(/\/+$/, "");
    const withScheme = /^https?:\/\//i.test(base) ? base : `https://${base}`;
    return `${withScheme}${preset.path ?? ""}`;
}
