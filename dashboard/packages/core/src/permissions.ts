/**
 * Role and permission model. Authorization is permission-based rather than
 * role-name-based so call sites ask "can this actor do X" instead of "is this
 * actor an admin", which keeps checks stable as roles evolve. Roles are just
 * named bundles of permissions; the seeded set covers the common cases and admin
 * additionally implies every permission.
 */

/** Every discrete capability a user can be granted. */
export const PERMISSIONS = [
    "drive.read",
    "drive.write",
    "drive.delete",
    "connections.manage",
    "shares.create",
    "shares.manage",
    "requests.create",
    "requests.manage",
    "snippets.read",
    "snippets.write",
    "vault.use",
    "notes.use",
    "office.use",
    "vpn.use",
    "mail.use",
    "mailserver.manage",
    "calendar.use",
    "crm.use",
    "translate.use",
    "automations.use",
    "alerts.topics",
    "automations.secrets",
    "status.manage",
    "chat.use",
    "chat.spaces",
    "chat.groups",
    "chat.attach",
    "chat.call",
    "chat.meetings",
    "arcade.open",
    "arcade.calls",
    "deploy.read",
    "deploy.manage",
    "games.read",
    "games.moderate",
    "games.console",
    "games.manage",
    "agents.read",
    "agents.manage",
    "polar.use",
    "polar.spend",
    "home.read",
    "home.control",
    "home.manage",
    "tools.use",
    "tools.manage",
    "tasks.read",
    "tasks.manage",
    "inbox.read",
    "inbox.manage",
    "family.manage",
    "users.manage",
    "settings.manage",
    "system.manage"
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * What holding the chat used to mean on its own.
 *
 * Named as a set because three places need the same list: the roles seeded on a
 * fresh instance, the one-time carry-forward that gives them to roles written
 * before they existed, and anything that wants to say "everything about chat".
 * Granting the chat and none of these would be an account that can read a
 * conversation and do nothing in it, which is not what "add the chat" means.
 */
export const CHAT_CAPABILITIES = [
    "chat.spaces",
    "chat.groups",
    "chat.attach",
    "chat.call"
] as const satisfies readonly Permission[];

/**
 * What the Games app adds, carried once to every role that already holds the
 * chat (`seedDefaultRoles`), so an update does not leave existing members
 * without a feature a fresh install grants them.
 */
export const GAMES_CAPABILITIES = [
    "arcade.open",
    "arcade.calls"
] as const satisfies readonly Permission[];

/** A wildcard a role may hold to mean "all current and future permissions". */
export const ALL_PERMISSIONS = "*" as const;

export type GrantedPermission = Permission | typeof ALL_PERMISSIONS;

/**
 * The built-in roles seeded on first run. Seeding never overwrites a role that
 * already exists, so these are starting points an operator is free to rewrite
 * under Management > Roles - what a member may do is a decision about one
 * instance, not a constant.
 *
 * `guest` grants nothing on purpose. It is an account that exists so a person can
 * be identified - to sign in at a share link or a drop point, or at something
 * outside Polaris that asks for a Polaris account - and reaches no app at all.
 */
export const DEFAULT_ROLES: Record<string, readonly GrantedPermission[]> = {
    admin: [ALL_PERMISSIONS],
    member: [
        "drive.read",
        "drive.write",
        "drive.delete",
        "connections.manage",
        "shares.create",
        "requests.create",
        "snippets.read",
        "snippets.write",
        "vault.use",
        "notes.use",
        "office.use",
        "vpn.use",
        "mail.use",
        "calendar.use",
        "crm.use",
        "translate.use",
        "automations.use",
        "alerts.topics",
        "automations.secrets",
        "chat.use",
        "chat.spaces",
        "chat.groups",
        "chat.attach",
        "chat.call",
        "arcade.open",
        "arcade.calls",
        "deploy.read",
        "deploy.manage",
        "games.read",
        "games.moderate",
        "games.console",
        "games.manage",
        "agents.read",
        "agents.manage",
        "home.read",
        "home.control",
        // Deliberately not "home.manage". Adding a camera makes Polaris open a
        // connection to an address and a port somebody typed, from inside the
        // network - the same reason registering a server was raised to an
        // administrative grant. Watching the house and pointing a camera are
        // everyday things; deciding what Polaris connects to is not.
        "tools.use",
        // And deliberately not "tools.manage", for the same shape of reason: a
        // converter is somebody's own business, while a short link is a public
        // address this Polaris answers for as long as it exists.
        "tasks.read",
        "tasks.manage",
        "inbox.read",
        "inbox.manage",
        // Creating and looking after a child's account. Every adult member by
        // default (D3); a minor never holds it, whatever their role says
        // (`MINOR_FLOOR` in minors.ts).
        "family.manage"
    ],
    viewer: [
        "drive.read",
        "snippets.read",
        // A vault reaches nothing in Polaris - it is a personal store only its
        // owner can decrypt - so withholding it from a read-only account would
        // deny them their own passwords without protecting anything.
        "vault.use",
        // The same reasoning: notes are the account's own and nobody else reads
        // them, so read-only has nothing to say about them.
        "notes.use",
        // And office documents, for the same reason again: a read-only account
        // still writes its own. What read-only governs is somebody else's work,
        // and a document reached through a share carries its own capability -
        // being handed a document to read is not the same grant as this one.
        "office.use",
        // And again for mail. A mailbox is reached with a credential its owner
        // supplied about an account that is theirs; read-only inside Polaris has
        // no bearing on whether somebody may read their own mail.
        "mail.use",
        "calendar.use",
        // The same again: a personal CRM is the account's own list of contacts.
        // What an organization's CRM lets somebody do is the organization's
        // roles, never this.
        "crm.use",
        "translate.use",
        "automations.use",
        "alerts.topics",
        "chat.use",
        "chat.spaces",
        "chat.groups",
        "chat.attach",
        "chat.call",
        "arcade.open",
        "arcade.calls",
        "deploy.read",
        "games.read",
        "agents.read",
        // Deliberately no home grant. Every other read here widens what somebody
        // can look at inside Polaris; this one points a camera at the people who
        // live in the house, and a role nobody chose to give it to should not
        // arrive holding it. An operator who wants it ticks one box.
        "tasks.read",
        "inbox.read"
    ],
    guest: []
};

/** Roles Polaris seeds itself. They may be rewritten but never deleted: an
 *  invite, a policy, or an account may still point at one. */
export const SYSTEM_ROLES = Object.keys(DEFAULT_ROLES);

/** The role whose grants are fixed. It holds the wildcard, so editing it would
 *  only ever narrow the one role that exists to be unrestricted. */
export const UNEDITABLE_ROLE = "admin";

/** Role names are typed by hand and read back in invites, policies and audit
 *  entries, so they stay short and predictable. */
export const MAX_ROLE_NAME_LENGTH = 32;

/** What a permission is called, the area it is filed under, and - for one that
 *  arrives with a marketplace app - that app's catalog id. */
export interface PermissionMeta {
    readonly area: string;
    readonly label: string;
    /** The app whose install brings this permission. Absent: every Polaris has it. */
    readonly app?: string;
}

/** What each permission is called, and the area it belongs to, so a role editor
 *  can group them the way the dashboard is grouped rather than listing keys. */
export const PERMISSION_META: Readonly<Record<Permission, PermissionMeta>> = {
    "drive.read": { area: "Drive", label: "See files and download them" },
    "drive.write": { area: "Drive", label: "Upload, rename and move files" },
    "drive.delete": { area: "Drive", label: "Delete files" },
    "connections.manage": { area: "Drive", label: "Add and configure storage connections" },
    "shares.create": { area: "Drive", label: "Create share links" },
    "shares.manage": { area: "Drive", label: "Manage everyone's share links" },
    "requests.create": { area: "Drive", label: "Create drop points" },
    "requests.manage": { area: "Drive", label: "Manage everyone's drop points" },
    "snippets.read": { area: "Drive", label: "See snippets and open shared ones" },
    "snippets.write": { area: "Drive", label: "Write snippets and share them by link" },
    "vault.use": { area: "Vault", label: "Keep a password vault and connect a client to it" },
    "notes.use": { area: "Notes", label: "Keep private notes" },
    "office.use": { area: "Office", label: "Write documents, spreadsheets, slides and diagrams" },
    "vpn.use": { area: "VPN", app: "vpn", label: "Connect a device to the VPN through an API key" },
    "mail.use": { area: "Mail", label: "Link mailboxes and read mail here" },
    // Not granted to members by default, and not implied by deploying: a mail
    // server opens port 25 to the internet and sends as whole domains, and one
    // badly run can put the machine's address on every blocklist there is. That
    // is a decision about the instance, the way registering a server is.
    "mailserver.manage": {
        area: "Mail",
        app: "mail-server",
        label: "Run a mail server, and manage its domains and mailboxes"
    },
    "calendar.use": {
        area: "Calendar",
        app: "calendar",
        label: "Keep calendars, link outside ones and take bookings"
    },
    // Opening the CRM at all. A personal CRM is reached by this alone; an
    // organization's records are governed by that organization's roles.
    "crm.use": { area: "CRM", app: "crm", label: "Keep companies, people and deals" },
    // Opening Translate and its API. Paid engines spend the owner's keys, so a
    // role can be kept off it.
    "translate.use": { area: "Translate", app: "translate", label: "Translate text" },
    // An automation acts as whoever published it and is re-checked on every run,
    // so this grants nothing the account could not already do by hand.
    "automations.use": { area: "Automations", label: "Make automations that act for you" },
    "automations.secrets": { area: "Automations", label: "Store secrets automations send" },
    // A topic is an address other systems post alerts to. An organization's
    // topics also need an admin of that organization.
    "alerts.topics": { area: "Alerts", label: "Receive alerts from other systems" },
    // Status pages make Polaris dial addresses somebody typed, from inside the
    // network, and publish what it finds. Admin only, like adding a camera.
    "status.manage": {
        area: "Status pages",
        app: "status-pages",
        label: "Run status pages and their checks"
    },
    "chat.use": { area: "Chat", label: "Talk in channels and direct messages" },
    // The four things somebody with the chat can do beyond talking in it. Split
    // out because "has the chat" and "may start a server in it" are different
    // decisions in every instance that has more than a handful of people, and
    // there was no way to say the second before this. All four are granted with
    // the chat by default, so nothing an account could do yesterday needs
    // granting today.
    "chat.spaces": { area: "Chat", label: "Create servers and their channels" },
    "chat.groups": { area: "Chat", label: "Start group conversations" },
    "chat.attach": { area: "Chat", label: "Attach files and send voice messages" },
    "chat.call": { area: "Chat", label: "Start and join calls" },
    // Not one of the four above and deliberately not granted with the chat. The
    // others are things somebody does inside Polaris with people who are already
    // in it; this one hands out an address that anybody at all can open, which is
    // a decision about the instance rather than about a conversation. Nobody
    // holds it until an operator says who does.
    "chat.meetings": {
        area: "Chat",
        label: "Create meeting links people outside Polaris can join"
    },
    // The Games app (not Game servers). Two decisions, like a chat platform's:
    // whether somebody may open games at all, and whether they may start or join
    // one inside a call. Both granted with the chat by default.
    "arcade.open": { area: "Games", app: "arcade", label: "Open Games" },
    "arcade.calls": { area: "Games", app: "arcade", label: "Play games in calls" },
    "deploy.read": { area: "Apps", label: "See deployments, servers and containers" },
    "deploy.manage": { area: "Apps", label: "Deploy, restart and configure apps" },
    "games.read": {
        area: "Game servers",
        app: "game-servers",
        label: "See game servers and who is playing"
    },
    "games.moderate": {
        area: "Game servers",
        app: "game-servers",
        label: "Op, kick, ban and whitelist players"
    },
    // Its own thing rather than part of managing, because the console is how every
    // other verb on this list can be done without going through the screen that
    // offers it. Somebody who should be able to run commands and not rebuild the
    // server had nowhere to sit before this.
    "games.console": {
        area: "Game servers",
        app: "game-servers",
        label: "Run commands on the server console"
    },
    "games.manage": {
        area: "Game servers",
        app: "game-servers",
        label: "Create servers, change settings and rebuild"
    },
    "agents.read": { area: "Apps", label: "See coding-agent repositories and runs" },
    "agents.manage": { area: "Apps", label: "Enable repositories and start agent runs" },
    // Polar, the assistant. Neither is in a seeded role: who has Polar when
    // nothing here says so is the deployment's Polar access (Management >
    // Agents), which predates these and stays the default. A role, a group's
    // policy or one account's override that names either one decides instead.
    "polar.use": { area: "Polar", label: "Talk to Polar" },
    // Every turn on the deployment's keys is billed to its administrator, which
    // is why this is apart from using Polar at all.
    "polar.spend": { area: "Polar", label: "Run Polar on this deployment's keys" },
    "home.read": { area: "Home", app: "home", label: "Watch the cameras and read what they saw" },
    // Pointing a camera somewhere is not the same decision as being allowed to
    // look at where it already points, and neither is silencing an alert.
    "home.control": { area: "Home", app: "home", label: "Move cameras and act on alerts" },
    "home.manage": {
        area: "Home",
        app: "home",
        label: "Add cameras, and set how they detect and record"
    },
    "tools.use": {
        area: "Tools",
        app: "tools",
        label: "Use the tools: convert, resize, translate"
    },
    // A short link is a public address this Polaris answers, and it outlives the
    // person who made it. Using a converter is nobody's business but theirs;
    // publishing a link is.
    "tools.manage": {
        area: "Tools",
        app: "tools",
        label: "Create short links and see who followed them"
    },
    "tasks.read": { area: "Tasks", label: "See spaces, lists and tasks" },
    "tasks.manage": { area: "Tasks", label: "Create and change tasks" },
    "inbox.read": { area: "Inbox", label: "Read conversations" },
    "inbox.manage": { area: "Inbox", label: "Reply and manage channels" },
    "family.manage": { area: "Family", label: "Create and look after children's accounts" },
    "users.manage": { area: "Management", label: "Invite people and change accounts" },
    "settings.manage": { area: "Management", label: "Change instance settings" },
    "system.manage": { area: "Management", label: "Updates, backups and maintenance" }
};

/** Every app some permission arrives with, each once. */
export const PERMISSION_APPS: readonly string[] = [
    ...new Set(Object.values(PERMISSION_META).flatMap((meta) => (meta.app ? [meta.app] : [])))
];

/**
 * The permissions a list of them shows, given the apps this Polaris has installed:
 * every one with no app, and those whose app is here. Only the listing narrows -
 * a grant of an uninstalled app's permission is kept as it is and shows again
 * when the app is reinstalled.
 */
export function listedPermissions(installed: Iterable<string>): Permission[] {
    const present = new Set(installed);
    return PERMISSIONS.filter((permission) => {
        const app = PERMISSION_META[permission].app;
        return !app || present.has(app);
    });
}

/**
 * Permissions that another one cannot sensibly be held without. Writing a file
 * you cannot read back, or managing shares you cannot create, is a grant that
 * only looks narrower than it is - so picking the broader permission carries the
 * narrower one with it.
 *
 * This is composition, not evaluation: grants are expanded when they are built
 * (see expandPermissions), and hasPermission still matches exactly, so what a
 * key or a role actually holds is always written out in full.
 */
export const IMPLIED_PERMISSIONS: Readonly<Partial<Record<Permission, readonly Permission[]>>> = {
    "drive.write": ["drive.read"],
    "drive.delete": ["drive.read"],
    "shares.manage": ["shares.create"],
    "requests.manage": ["requests.create"],
    "snippets.write": ["snippets.read"],
    // Spending the deployment's keys on Polar without being able to open it.
    "polar.spend": ["polar.use"],
    // Whoever may deploy anything on this machine may already run a game server
    // on it, so the game-server grants ride along - which also means an operator
    // who set their roles up before these existed does not have to redo them.
    "deploy.manage": [
        "deploy.read",
        "games.read",
        "games.moderate",
        "games.console",
        "games.manage"
    ],
    "deploy.read": ["games.read"],
    "games.moderate": ["games.read"],
    "games.console": ["games.read"],
    // Managing still carries the console, so every grant that worked yesterday
    // works today and nobody loses a screen they had.
    "games.manage": ["games.read", "games.moderate", "games.console"],
    "agents.manage": ["agents.read"],
    "home.control": ["home.read"],
    "home.manage": ["home.read", "home.control"],
    "tasks.manage": ["tasks.read"],
    "inbox.manage": ["inbox.read"]
};

/** The permissions one grant carries with it, itself excluded. */
export function impliedBy(permission: Permission): readonly Permission[] {
    return IMPLIED_PERMISSIONS[permission] ?? [];
}

/**
 * Complete a set of permissions with everything its members imply, in the
 * canonical PERMISSIONS order so a stored grant reads the same however it was
 * picked.
 */
export function expandPermissions(granted: Iterable<Permission>): Permission[] {
    const expanded = new Set<Permission>();
    for (const permission of granted) {
        expanded.add(permission);
        for (const implied of impliedBy(permission)) expanded.add(implied);
    }
    return PERMISSIONS.filter((permission) => expanded.has(permission));
}

/**
 * Resolve whether a set of granted permissions satisfies a required one. The
 * wildcard grant short-circuits to true, which is how the admin role implies
 * everything without enumerating each key.
 */
export function hasPermission(granted: Iterable<GrantedPermission>, required: Permission): boolean {
    for (const grant of granted) {
        if (grant === ALL_PERMISSIONS || grant === required) return true;
    }
    return false;
}

/** Merge the permissions of several roles into one deduplicated set. */
export function mergeRolePermissions(
    roles: Iterable<readonly GrantedPermission[]>
): Set<GrantedPermission> {
    const merged = new Set<GrantedPermission>();
    for (const role of roles) {
        for (const grant of role) merged.add(grant);
    }
    return merged;
}
