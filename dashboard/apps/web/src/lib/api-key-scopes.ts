/**
 * Human labels for the permission scopes an API key can carry, and the grouping
 * the key dialog reads them in: one section per resource, broadest permission
 * last, so what a key can reach is scannable rather than a flat checklist.
 *
 * Client-safe on purpose: the key dialog renders these, so this module must not
 * reach for anything that drags the database layer into the browser bundle.
 * Resolving which scopes a user may actually pick lives server-side, in
 * @polaris/auth.
 */

import type { Permission } from "@polaris/core";
import type { ScopeLevels } from "@/lib/scope-levels";

export const SCOPE_LABELS: Readonly<Record<Permission, string>> = {
    "drive.read": "Read files",
    "drive.write": "Write files",
    "drive.delete": "Delete files",
    "connections.manage": "Manage storage connections",
    "shares.create": "Create share links",
    "shares.manage": "Manage all share links",
    "requests.create": "Create drop points",
    "requests.manage": "Manage all drop points",
    "snippets.read": "Read snippets",
    "snippets.write": "Write snippets",
    "vault.use": "Use the vault",
    "notes.use": "Keep notes",
    "office.use": "Write documents",
    "vpn.use": "Connect to the VPN",
    "mail.use": "Read and send mail",
    "calendar.use": "Read and change calendars",
    "crm.use": "Read and change CRM records",
    "translate.use": "Translate text",
    "automations.use": "Read and change automations",
    "automations.secrets": "Store automation secrets",
    "alerts.topics": "Manage alert topics",
    "status.manage": "Run status pages and their checks",
    "mailserver.manage": "Run mail servers",
    "chat.use": "Use chat",
    "chat.spaces": "Create chat servers",
    "chat.groups": "Start group conversations",
    "chat.attach": "Send files in chat",
    "chat.call": "Join chat calls",
    "chat.meetings": "Create meeting links",
    "arcade.open": "Open Games",
    "arcade.calls": "Play games in calls",
    "polar.use": "Talk to Polar",
    "polar.spend": "Spend this deployment's keys on Polar",
    "deploy.read": "Read deployments",
    "deploy.manage": "Manage deployments",
    "games.read": "Read game servers",
    "games.moderate": "Moderate players",
    "games.console": "Use the console",
    "games.manage": "Manage game servers",
    "agents.read": "Read agent runs",
    "agents.manage": "Manage agent repositories",
    "home.read": "Watch cameras",
    "home.control": "Move cameras",
    "home.manage": "Manage cameras",
    "tools.use": "Use the tools",
    "tools.manage": "Manage short links",
    "tasks.read": "Read tasks",
    "tasks.manage": "Manage tasks",
    "inbox.read": "Read conversations",
    "inbox.manage": "Manage conversations",
    "family.manage": "Manage children's accounts",
    "users.manage": "Manage users",
    "settings.manage": "Manage settings",
    "system.manage": "Manage the system"
};

/** What each scope actually lets the key do, in the terms a caller would use. */
export const SCOPE_HINTS: Readonly<Record<Permission, string>> = {
    "drive.read": "List folders and download files.",
    "drive.write": "Upload, rename, and move files.",
    "drive.delete": "Send files to the trash and empty it.",
    "connections.manage": "Add, edit, and remove storage connections.",
    "shares.create": "Share files the key can already read.",
    "shares.manage": "Edit and revoke share links from anyone.",
    "requests.create": "Open drop points for others to upload to.",
    "requests.manage": "Edit and close drop points from anyone.",
    "snippets.read": "Read the owner's snippets and their share links.",
    "snippets.write": "Write snippets, share them by link, and close text drop points.",
    // A key carries no master key, so it moves the encrypted vault around without
    // ever being able to read it. Say so, or the scope reads as far broader than
    // it is.
    "vault.use": "Sync the vault. The items stay encrypted; a key cannot read them.",
    "notes.use": "Read and write the owner's own notes.",
    "vpn.use": "List the VPN servers this account may use and register a device on one.",
    "office.use":
        "Read and write the documents, spreadsheets, slides and diagrams the owner can reach.",
    "mail.use": "Read the owner's linked mailboxes and send from them.",
    "calendar.use": "Read and change the calendars the owner reaches, and their booking pages.",
    "crm.use": "List, create, change and delete companies, people and opportunities in the CRM.",
    "translate.use": "Translate text and detect its language with the engines this Polaris offers.",
    "automations.use": "List, create, change, publish and run the owner's automations.",
    "automations.secrets": "Store secrets for automations. A stored secret is never read back.",
    "alerts.topics": "Create the topics other systems post alerts to.",
    "status.manage": "Create status pages, run their checks, and post incidents and maintenance.",
    "mailserver.manage":
        "Set up the mail servers the owner runs, and manage their domains, mailboxes and records.",
    "chat.use": "Read and post in the channels the owner is in.",
    "chat.spaces": "Create servers and the channels inside them.",
    "chat.groups": "Open a conversation with several people at once.",
    "chat.attach": "Put files and voice messages on a message.",
    "chat.call": "Start a call in a conversation, and join one.",
    "arcade.open": "Open the Games library and play on your own.",
    "arcade.calls": "Start a game inside a call, or join one somebody started.",
    "polar.use": "Open Polar and talk to it.",
    "polar.spend": "Run Polar on the deployment's own provider keys instead of your own.",
    "chat.meetings": "Create meetings anybody holding the link can join, and host them.",
    "deploy.read": "Inspect apps, deployments, and logs.",
    "deploy.manage": "Deploy, restart, and remove apps.",
    "games.read": "See game servers, their addresses, and who is playing.",
    "games.moderate": "Op, kick, ban, and whitelist players.",
    "games.console": "Send commands to a running server, which is every other verb here and more.",
    "games.manage": "Create servers, run console commands, and change settings.",
    "agents.read": "List enabled repositories and read run history.",
    "agents.manage": "Enable repositories, change how they run, and start runs.",
    "home.read": "Open a live view, take a snapshot, and read detections and clips.",
    "home.control": "Pan, tilt and zoom a camera, and dismiss what it reported.",
    "home.manage": "Add and remove cameras, and change how they detect and record.",
    "tools.use":
        "Convert, resize, optimize and read files, and translate text. Files sent through a tool are processed and not kept.",
    "tools.manage": "Create short links this Polaris answers for, and see who followed them.",
    "tasks.read": "Read spaces, lists, and tasks.",
    "tasks.manage": "Create and change tasks, lists, and spaces.",
    "inbox.read": "Read conversations, contacts, and channel activity.",
    "inbox.manage": "Reply, assign, and connect or remove channels.",
    "family.manage": "Create children's accounts and change what they may use.",
    "users.manage": "Invite, edit, and remove users.",
    "settings.manage": "Change instance settings.",
    "system.manage": "Run updates and system operations."
};

export interface ScopeGroup {
    readonly title: string;
    readonly scopes: readonly Permission[];
    /** The app whose logo is drawn beside the area, when it has one. */
    readonly app?: string;
    /** None / read / read and write, for an area where those are the choice. */
    readonly levels?: ScopeLevels;
}

/** Resource sections, in the order the dialog shows them. */
export const SCOPE_GROUPS: readonly ScopeGroup[] = [
    {
        // i18n-ignore said in the reader's words by account/api-keys/scope-picker
        title: "Storage",
        scopes: ["drive.read", "drive.write", "drive.delete", "connections.manage"],
        app: "drive",
        levels: { read: ["drive.read"], write: ["drive.read", "drive.write", "drive.delete"] }
    },
    {
        // i18n-ignore said in the reader's words by account/api-keys/scope-picker
        title: "Sharing",
        scopes: ["shares.create", "shares.manage", "requests.create", "requests.manage"],
        app: "drive"
    },
    {
        // i18n-ignore said in the reader's words by account/api-keys/scope-picker
        title: "Snippets",
        scopes: ["snippets.read", "snippets.write"],
        levels: { read: ["snippets.read"], write: ["snippets.read", "snippets.write"] }
    },
    // i18n-ignore said in the reader's words by account/api-keys/scope-picker
    { title: "Vault", scopes: ["vault.use"], app: "vault" },
    // i18n-ignore said in the reader's words by account/api-keys/scope-picker
    { title: "Notes", scopes: ["notes.use"], app: "notes" },
    // i18n-ignore said in the reader's words by account/api-keys/scope-picker
    { title: "Office", scopes: ["office.use"], app: "office" },
    // i18n-ignore said in the reader's words by account/api-keys/scope-picker
    { title: "VPN", scopes: ["vpn.use"], app: "vpn" },
    // i18n-ignore said in the reader's words by account/api-keys/scope-picker
    { title: "Mail", scopes: ["mail.use", "mailserver.manage"], app: "mail" },
    // i18n-ignore said in the reader's words by account/api-keys/scope-picker
    { title: "Calendar", scopes: ["calendar.use"], app: "calendar" },
    {
        // i18n-ignore said in the reader's words by account/api-keys/scope-picker
        title: "Chat",
        scopes: [
            "chat.use",
            "chat.spaces",
            "chat.groups",
            "chat.attach",
            "chat.call",
            "chat.meetings"
        ],
        app: "chat"
    },
    {
        // i18n-ignore said in the reader's words by account/api-keys/scope-picker
        title: "Deployments",
        scopes: ["deploy.read", "deploy.manage"],
        levels: { read: ["deploy.read"], write: ["deploy.read", "deploy.manage"] }
    },
    {
        // i18n-ignore said in the reader's words by account/api-keys/scope-picker
        title: "Game servers",
        scopes: ["games.read", "games.moderate", "games.console", "games.manage"],
        app: "games",
        levels: {
            read: ["games.read"],
            write: ["games.read", "games.moderate", "games.console", "games.manage"]
        }
    },
    {
        // i18n-ignore said in the reader's words by account/api-keys/scope-picker
        title: "Agents",
        scopes: ["agents.read", "agents.manage"],
        levels: { read: ["agents.read"], write: ["agents.read", "agents.manage"] }
    },
    // i18n-ignore said in the reader's words by account/api-keys/scope-picker
    { title: "Polar", scopes: ["polar.use", "polar.spend"], app: "polar" },
    {
        // i18n-ignore said in the reader's words by account/api-keys/scope-picker
        title: "Home",
        scopes: ["home.read", "home.control", "home.manage"],
        app: "home",
        levels: { read: ["home.read"], write: ["home.read", "home.control", "home.manage"] }
    },
    // i18n-ignore said in the reader's words by account/api-keys/scope-picker
    { title: "Tools", scopes: ["tools.use", "tools.manage"], app: "tools" },
    {
        // i18n-ignore said in the reader's words by account/api-keys/scope-picker
        title: "Tasks",
        scopes: ["tasks.read", "tasks.manage"],
        app: "tasks",
        levels: { read: ["tasks.read"], write: ["tasks.read", "tasks.manage"] }
    },
    {
        // i18n-ignore said in the reader's words by account/api-keys/scope-picker
        title: "Inbox",
        scopes: ["inbox.read", "inbox.manage"],
        levels: { read: ["inbox.read"], write: ["inbox.read", "inbox.manage"] }
    },
    // i18n-ignore said in the reader's words by account/api-keys/scope-picker
    { title: "Family", scopes: ["family.manage"] },
    {
        // i18n-ignore said in the reader's words by account/api-keys/scope-picker
        title: "Administration",
        scopes: ["users.manage", "settings.manage", "system.manage"],
        app: "admin"
    }
];

/** Where an area's name is in the `account` catalog: `SCOPE_GROUPS` names each
 *  in English, and the catalog holds the same names by that English,
 *  camel-cased. */
export function scopeGroupKey(title: string): string {
    const camel = title
        .replace(/ (\w)/g, (_, letter: string) => letter.toUpperCase())
        .replace(/^\w/, (letter) => letter.toLowerCase());
    return `apiKeys.scopes.groups.${camel}`;
}

/** Scopes sorted into the areas above, each area in the order the scopes were
 *  given. `placeOf` names the permission a scope is filed under, for a scope
 *  that is not one itself. What no area lists is returned as `rest`, for the
 *  caller's "Other". */
export function groupScopes(
    scopes: readonly string[],
    placeOf: (scope: string) => string = (scope) => scope
): {
    groups: { title: string; scopes: string[] }[];
    rest: string[];
} {
    const groups = SCOPE_GROUPS.map((group) => {
        const members = new Set<string>(group.scopes);
        return {
            title: group.title,
            scopes: scopes.filter((scope) => members.has(placeOf(scope)))
        };
    }).filter((group) => group.scopes.length > 0);
    const listed = new Set<string>(groups.flatMap((group) => group.scopes));
    return { groups, rest: scopes.filter((scope) => !listed.has(scope)) };
}
