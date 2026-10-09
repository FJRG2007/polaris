/**
 * Every scope an MCP credential can carry, and what each one stands on.
 *
 * Two kinds. Most scopes are a Polaris permission key (`tasks.read`), the same
 * model API keys use, so a scope means the same thing on both credentials. The
 * rest exist only here: a finer cut of one permission that a person may want to
 * hand an assistant in part - reading their mail and not sending it, seeing a
 * device and not switching it. A role never holds one of those. Each names the
 * permission it `requires`, and is good at the moment of a call only while the
 * person holds that permission, exactly as a permission scope is.
 *
 * One table, read by everything that names a scope: the consent screen, the
 * edit dialog on the AI assistants page, the token response, the
 * `WWW-Authenticate` challenge and the protocol's own check. Adding a scope is
 * a line here and its label in `messages/<locale>/mcp.json`, and nothing else.
 *
 * Every scope is also filed under a category (`MCP_CATEGORIES`): what the
 * consent screen, the edit dialog and the API key picker group the boxes by,
 * and what `polaris_tools` groups the tools by, so a scope and the tools that
 * use it are found under the same heading everywhere. A permission's category
 * is `PERMISSION_CATEGORIES` below, a finer scope's is on its rule; both are
 * typed, so a new one cannot be added without one, and each category's label
 * is `categories.<id>` in `messages/<locale>/mcp.json` (a test holds every
 * locale to it).
 *
 * Client-safe: no server module is imported, so the screens read it directly.
 */

import { PERMISSIONS, impliedBy, type Permission } from "@polaris/core";

/**
 * The headings scopes and tools are grouped under, in the order they are
 * shown. `polaris` is for what belongs to no app (who am I, search, the list
 * of tools) and is never a scope's.
 */
export const MCP_CATEGORIES = [
    "polaris",
    "home",
    "mail",
    "calendar",
    "chat",
    "productivity",
    "files",
    "development",
    "databases",
    "games",
    "account"
] as const;

export type McpCategory = (typeof MCP_CATEGORIES)[number];

/** Where each permission is filed. A `Record` over every permission, so one
 *  added to `@polaris/core` without a category here does not compile. */
export const PERMISSION_CATEGORIES: Readonly<Record<Permission, McpCategory>> = {
    "drive.read": "files",
    "drive.write": "files",
    "drive.delete": "files",
    "connections.manage": "files",
    "shares.create": "files",
    "shares.manage": "files",
    "requests.create": "files",
    "requests.manage": "files",
    "snippets.read": "productivity",
    "snippets.write": "productivity",
    "vault.use": "account",
    "notes.use": "productivity",
    "office.use": "productivity",
    "mail.use": "mail",
    "mailserver.manage": "mail",
    "calendar.use": "calendar",
    "crm.use": "productivity",
    "chat.use": "chat",
    "chat.spaces": "chat",
    "chat.groups": "chat",
    "chat.attach": "chat",
    "chat.call": "chat",
    "chat.meetings": "chat",
    "deploy.read": "development",
    "deploy.manage": "development",
    "games.read": "games",
    "games.moderate": "games",
    "games.console": "games",
    "games.manage": "games",
    "agents.read": "development",
    "agents.manage": "development",
    "home.read": "home",
    "home.control": "home",
    "home.manage": "home",
    "tools.use": "productivity",
    "tools.manage": "productivity",
    "tasks.read": "productivity",
    "tasks.manage": "productivity",
    "inbox.read": "chat",
    "inbox.manage": "chat",
    "users.manage": "account",
    "settings.manage": "account",
    "system.manage": "account"
};

interface ScopeRule {
    /** The permission a person must hold for the scope to do anything. */
    readonly requires: Permission;
    /** The heading it is grouped under. */
    readonly category: McpCategory;
    /** Scopes it cannot sensibly be held without, ticked with it. Finer scopes
     *  of this table; a test holds every one to that. */
    readonly implies?: readonly string[];
    /** Never ticked on the consent screen until the person ticks it: what it
     *  allows reaches outside Polaris or acts on the physical world. */
    readonly sensitive?: boolean;
}

/**
 * The scopes that are not permissions.
 *
 * Named `<area>.<verb>`, one dot, so the label key (`scopes.<area>_<verb>`)
 * stays one level deep. Never a permission's own name: that would make a key
 * holding the permission and an assistant holding the scope two different
 * grants under one word.
 */
export const MCP_ONLY_SCOPES = {
    "mail.read": { requires: "mail.use", category: "mail" },
    // Sending is its own grant: an assistant that writes to people outside
    // Polaris in the person's name is a different decision from one that reads.
    "mail.send": { requires: "mail.use", category: "mail", sensitive: true },
    "calendar.read": { requires: "calendar.use", category: "calendar" },
    "calendar.manage": {
        requires: "calendar.use",
        category: "calendar",
        implies: ["calendar.read"],
        sensitive: true
    },
    "places.read": { requires: "home.read", category: "home" },
    "places.control": {
        requires: "home.control",
        category: "home",
        implies: ["places.read"],
        sensitive: true
    },
    // Running a routine by hand is what Places' own screen gates on managing
    // the house, not on controlling one device: a routine does whatever its
    // owner set it to.
    "places.routines": {
        requires: "home.manage",
        category: "home",
        implies: ["places.read"],
        sensitive: true
    },
    // A camera's picture is the inside of somebody's home, and it is what the
    // device scopes deliberately leave out: its own grant, on what lets a
    // person watch the cameras on the screen.
    "places.cameras": { requires: "home.read", category: "home", sensitive: true },
    // The Databases app's own gate is `deploy.read`; the connection's read-only
    // switch is what stops a write there. Reading rows and changing them are two
    // decisions here, and both reach a database outside Polaris.
    "databases.read": { requires: "deploy.read", category: "databases", sensitive: true },
    "databases.write": {
        requires: "deploy.read",
        category: "databases",
        implies: ["databases.read"],
        sensitive: true
    },
    "gameservers.read": { requires: "games.read", category: "games" },
    // Kicking, banning and timing out are done to people, and a role can hold
    // them without managing the server: the moderators' own grant.
    "gameservers.moderate": {
        requires: "games.moderate",
        category: "games",
        implies: ["gameservers.read"],
        sensitive: true
    },
    "gameservers.manage": {
        requires: "games.manage",
        category: "games",
        implies: ["gameservers.read"],
        sensitive: true
    }
} as const satisfies Readonly<Record<string, ScopeRule>>;

export type McpOnlyScope = keyof typeof MCP_ONLY_SCOPES;

/** A scope an MCP credential can carry. */
export type McpScope = Permission | McpOnlyScope;

/**
 * Scopes that are honoured for the grants that hold them but never offered
 * again, each with what replaced it. `calendar.use` was the one calendar scope
 * before reading and changing were split; a grant that holds it keeps reading
 * its upcoming events, and an app that still asks for it by name is offered
 * the read scope instead.
 */
export const LEGACY_SCOPES: Readonly<Partial<Record<McpScope, McpScope>>> = {
    "calendar.use": "calendar.read"
};

const RULES: Readonly<Record<string, ScopeRule>> = MCP_ONLY_SCOPES;

/**
 * Every scope, in the order a list shows them: each permission, followed by
 * the finer scopes that stand on it. A stored or drawn set always reads the
 * same however it was picked.
 */
export const MCP_SCOPES: readonly McpScope[] = PERMISSIONS.flatMap((permission) => [
    permission as McpScope,
    ...(Object.keys(MCP_ONLY_SCOPES) as McpOnlyScope[]).filter(
        (scope) => MCP_ONLY_SCOPES[scope].requires === permission
    )
]);

const KNOWN = new Set<string>(MCP_SCOPES);
const ORDER = new Map<string, number>(MCP_SCOPES.map((scope, index) => [scope, index]));

/** Whether a string is a scope this Polaris knows. Stored grants are read
 *  through this, so a scope that no longer exists is ignored, not trusted. */
export function isMcpScope(value: string): value is McpScope {
    return KNOWN.has(value);
}

/** Whether a scope is a finer cut rather than a permission. */
export function isMcpOnlyScope(value: string): value is McpOnlyScope {
    return Object.hasOwn(RULES, value);
}

/** The permission a scope stands on. */
export function scopeRequires(scope: McpScope): Permission {
    return isMcpOnlyScope(scope) ? MCP_ONLY_SCOPES[scope].requires : scope;
}

/** What a scope carries with it, itself excluded. */
export function scopeImplies(scope: McpScope): readonly McpScope[] {
    return isMcpOnlyScope(scope)
        ? ((RULES[scope]?.implies ?? []) as readonly McpScope[])
        : impliedBy(scope);
}

/** Whether a scope waits for the person to tick it on the consent screen. */
export function isSensitiveScope(scope: McpScope): boolean {
    return isMcpOnlyScope(scope) && RULES[scope]?.sensitive === true;
}

/** The heading a scope is grouped under. */
export function scopeCategory(scope: McpScope): McpCategory {
    return isMcpOnlyScope(scope) ? MCP_ONLY_SCOPES[scope].category : PERMISSION_CATEGORIES[scope];
}

/** Scopes sorted into their categories, the categories in `MCP_CATEGORIES`'
 *  order and the scopes in each in the table's. Empty categories are left out. */
export function groupByCategory<S extends McpScope>(
    scopes: Iterable<S>
): { category: McpCategory; scopes: S[] }[] {
    const ordered = orderScopes(scopes) as S[];
    return MCP_CATEGORIES.map((category) => ({
        category,
        scopes: ordered.filter((scope) => scopeCategory(scope) === category)
    })).filter((group) => group.scopes.length > 0);
}

/** Whether a scope is kept for old grants and never offered to a new one. */
export function isLegacyScope(scope: McpScope): boolean {
    return LEGACY_SCOPES[scope] !== undefined;
}

/** Put scopes in the table's order, once each. */
export function orderScopes(scopes: Iterable<McpScope>): McpScope[] {
    return [...new Set(scopes)].sort(
        (left, right) => (ORDER.get(left) ?? 0) - (ORDER.get(right) ?? 0)
    );
}

/** Complete a set of scopes with everything its members imply. */
export function expandScopes(scopes: Iterable<McpScope>): McpScope[] {
    const expanded = new Set<McpScope>();
    for (const scope of scopes) {
        expanded.add(scope);
        for (const implied of scopeImplies(scope)) expanded.add(implied);
    }
    return orderScopes(expanded);
}

/** The scopes among these whose permission a person holds. */
export function scopesHeld(
    scopes: readonly McpScope[],
    permissions: Iterable<Permission>
): McpScope[] {
    const held = new Set(permissions);
    return scopes.filter((scope) => held.has(scopeRequires(scope)));
}

/** The known scopes in a stored list, in order; anything else is dropped. */
export function readScopes(stored: readonly string[]): McpScope[] {
    return orderScopes(stored.filter(isMcpScope));
}
