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
 * Client-safe: no server module is imported, so the screens read it directly.
 */

import { PERMISSIONS, impliedBy, type Permission } from "@polaris/core";

interface ScopeRule {
    /** The permission a person must hold for the scope to do anything. */
    readonly requires: Permission;
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
    "mail.read": { requires: "mail.use" },
    // Sending is its own grant: an assistant that writes to people outside
    // Polaris in the person's name is a different decision from one that reads.
    "mail.send": { requires: "mail.use", sensitive: true },
    "calendar.read": { requires: "calendar.use" },
    "calendar.manage": { requires: "calendar.use", implies: ["calendar.read"], sensitive: true },
    "places.read": { requires: "home.read" },
    "places.control": { requires: "home.control", implies: ["places.read"], sensitive: true },
    // Running a routine by hand is what Places' own screen gates on managing
    // the house, not on controlling one device: a routine does whatever its
    // owner set it to.
    "places.routines": { requires: "home.manage", implies: ["places.read"], sensitive: true },
    "gameservers.read": { requires: "games.read" },
    "gameservers.manage": {
        requires: "games.manage",
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
