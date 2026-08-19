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
    "chat.use",
    "chat.spaces",
    "chat.groups",
    "chat.attach",
    "chat.call",
    "chat.meetings",
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
    "home.manage",
    "tasks.read",
    "tasks.manage",
    "inbox.read",
    "inbox.manage",
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
        "chat.use",
        "chat.spaces",
        "chat.groups",
        "chat.attach",
        "chat.call",
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
        "tasks.read",
        "tasks.manage",
        "inbox.read",
        "inbox.manage"
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
        "chat.use",
        "chat.spaces",
        "chat.groups",
        "chat.attach",
        "chat.call",
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

/** What each permission is called, and the area it belongs to, so a role editor
 *  can group them the way the dashboard is grouped rather than listing keys. */
export const PERMISSION_META: Readonly<Record<Permission, { area: string; label: string }>> = {
    "drive.read": { area: "Drive", label: "See files and download them" },
    "drive.write": { area: "Drive", label: "Upload, rename and move files" },
    "drive.delete": { area: "Drive", label: "Delete files" },
    "connections.manage": { area: "Drive", label: "Add and configure storage connections" },
    "shares.create": { area: "Sharing", label: "Create share links" },
    "shares.manage": { area: "Sharing", label: "Manage everyone's share links" },
    "requests.create": { area: "Sharing", label: "Create drop points" },
    "requests.manage": { area: "Sharing", label: "Manage everyone's drop points" },
    "snippets.read": { area: "Snippets", label: "See snippets and open shared ones" },
    "snippets.write": { area: "Snippets", label: "Write snippets and share them by link" },
    "vault.use": { area: "Vault", label: "Keep a password vault and connect a client to it" },
    "notes.use": { area: "Notes", label: "Keep private notes" },
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
    "deploy.read": { area: "Apps", label: "See deployments, servers and containers" },
    "deploy.manage": { area: "Apps", label: "Deploy, restart and configure apps" },
    "games.read": { area: "Game servers", label: "See game servers and who is playing" },
    "games.moderate": { area: "Game servers", label: "Op, kick, ban and whitelist players" },
    // Its own thing rather than part of managing, because the console is how every
    // other verb on this list can be done without going through the screen that
    // offers it. Somebody who should be able to run commands and not rebuild the
    // server had nowhere to sit before this.
    "games.console": { area: "Game servers", label: "Run commands on the server console" },
    "games.manage": { area: "Game servers", label: "Create servers, change settings and rebuild" },
    "agents.read": { area: "Apps", label: "See coding-agent repositories and runs" },
    "agents.manage": { area: "Apps", label: "Enable repositories and start agent runs" },
    "home.read": { area: "Home", label: "Watch the cameras and read what they saw" },
    // Pointing a camera somewhere is not the same decision as being allowed to
    // look at where it already points, and neither is silencing an alert.
    "home.control": { area: "Home", label: "Move cameras and act on alerts" },
    "home.manage": { area: "Home", label: "Add cameras, and set how they detect and record" },
    "tasks.read": { area: "Tasks", label: "See spaces, lists and tasks" },
    "tasks.manage": { area: "Tasks", label: "Create and change tasks" },
    "inbox.read": { area: "Inbox", label: "Read conversations" },
    "inbox.manage": { area: "Inbox", label: "Reply and manage channels" },
    "users.manage": { area: "Management", label: "Invite people and change accounts" },
    "settings.manage": { area: "Management", label: "Change instance settings" },
    "system.manage": { area: "Management", label: "Updates, backups and maintenance" }
};

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
