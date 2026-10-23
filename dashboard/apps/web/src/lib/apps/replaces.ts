/**
 * What each app replaces: the products somebody already pays for or runs that
 * the app does the job of today. Keyed by the app's store id - a marketplace
 * app's catalog id, a Deploy template's `template-<id>`, or a built-in app's
 * switcher id - and read by the app's store page and its built-in row. An app with nothing here shows no row.
 *
 * Only claims that are true of what the app does now. A product Polaris only
 * connects to (Gmail as a mailbox, Dropbox as storage) is listed where the app
 * also does that product's job on its own, never because of the connection.
 *
 * `logo` names a tile in `docs/assets/logos`, the README's logo set, served to
 * the app from `public/logos/brands` (a byte-for-byte copy a test keeps equal).
 */

export interface ReplacedProduct {
    /** The product as its maker names it; a name, never translated. */
    readonly name: string;
    /** The tile's file name, without `.svg`. */
    readonly logo: string;
}

const product = (name: string, logo: string): ReplacedProduct => ({ name, logo });

export const APP_REPLACES: Readonly<Record<string, readonly ReplacedProduct[]>> = {
    // Built in: Deploy, Analytics and the rest of Apps.
    apps: [
        product("Railway", "railway"),
        product("Render", "render"),
        product("Fly.io", "fly-io"),
        product("Vercel", "vercel"),
        product("Google Analytics", "google-analytics"),
        product("Plausible", "plausible")
    ],
    chat: [
        product("Discord", "discord"),
        product("Slack", "slack"),
        product("WhatsApp", "whatsapp"),
        product("Telegram", "telegram"),
        product("Signal", "signal"),
        product("Zoom", "zoom"),
        product("Google Meet", "google-meet"),
        product("Microsoft Teams", "microsoft-teams")
    ],
    tasks: [
        product("ClickUp", "clickup"),
        product("Jira", "jira"),
        product("Linear", "linear"),
        product("Asana", "asana"),
        product("Trello", "trello")
    ],
    drive: [
        product("Google Drive", "google-drive"),
        product("Dropbox", "dropbox"),
        product("Nextcloud", "nextcloud")
    ],
    vault: [product("Bitwarden", "bitwarden"), product("1Password", "1password")],
    mail: [product("Gmail", "gmail"), product("Microsoft Outlook", "microsoft-outlook")],
    notes: [product("Notion", "notion"), product("Obsidian", "obsidian")],
    office: [
        product("Google Docs", "google-docs"),
        product("Google Sheets", "google-sheets"),
        product("Google Slides", "google-slides"),
        product("Microsoft 365", "microsoft")
    ],
    polar: [product("ChatGPT", "openai"), product("Claude", "claude")],
    automations: [
        product("Zapier", "zapier"),
        product("Make", "make"),
        product("n8n", "n8n"),
        product("IFTTT", "ifttt")
    ],
    watch: [product("Uptime Kuma", "uptime-kuma"), product("Better Stack", "better-stack")],
    // Marketplace apps.
    calendar: [
        product("Google Calendar", "google-calendar"),
        product("Proton Calendar", "proton-calendar"),
        product("Calendly", "calendly")
    ],
    home: [product("Home Assistant", "home-assistant"), product("Homeway", "homeway")],
    "game-servers": [product("Pterodactyl", "pterodactyl")],
    "status-pages": [product("Statuspage", "statuspage"), product("Instatus", "instatus")],
    "dns-blocker": [product("Pi-hole", "pi-hole"), product("AdGuard Home", "adguard")],
    "mail-server": [product("Microsoft 365", "microsoft")],
    crm: [product("HubSpot", "hubspot")],
    // Deploy templates in the user marketplace, by their store id.
    "template-n8n": [product("Zapier", "zapier"), product("Make", "make")],
    "template-nextcloud": [product("Google Drive", "google-drive"), product("Dropbox", "dropbox")],
    "template-umami": [product("Google Analytics", "google-analytics")],
    "template-open-webui": [product("ChatGPT", "openai")],
    "template-mattermost": [product("Slack", "slack")],
    "template-gitea": [product("GitHub", "github")]
};

/** What `appId` replaces, in the order it is listed; empty for nothing. */
export function appReplaces(appId: string): readonly ReplacedProduct[] {
    return APP_REPLACES[appId] ?? [];
}

/** Where the app serves a product's tile. */
export function replacedLogoSrc(item: ReplacedProduct): string {
    return `/logos/brands/${item.logo}.svg`;
}

/** What `appId` replaces, each with the address its tile is served from. */
export function replacedLogos(appId: string): { name: string; src: string }[] {
    return appReplaces(appId).map((item) => ({ name: item.name, src: replacedLogoSrc(item) }));
}
