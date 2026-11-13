/**
 * One app's access on a credential as a single choice - none, read, or read
 * and write - over the same permission scopes MCP tokens and API keys carry.
 * Nothing new is stored: a level is a name for a set of scopes, so a key keeps
 * exactly the scopes it was given, and one ticked by hand that no level
 * describes reads as a custom choice rather than being rewritten.
 *
 * Client-safe and pure; the picker and its tests read it.
 */

import { expandPermissions, type Permission } from "@polaris/core";

export type ScopeLevel = "none" | "read" | "write";

/** The scopes that make up each level of one app. Scopes of the app that are
 *  in neither (managing storage connections) stay boxes of their own. */
export interface ScopeLevels {
    readonly read: readonly Permission[];
    readonly write: readonly Permission[];
}

function levelScopes(levels: ScopeLevels): Set<Permission> {
    return new Set([...levels.read, ...levels.write]);
}

function sameSet(left: ReadonlySet<Permission>, right: ReadonlySet<Permission>): boolean {
    return left.size === right.size && [...left].every((scope) => right.has(scope));
}

/**
 * The level a set of scopes amounts to, or null when it is none of them -
 * write without read's own scopes, or half of write. `scopes` is what the key
 * carries, implied scopes included or not: it is expanded here.
 */
export function levelOf(levels: ScopeLevels, scopes: readonly Permission[]): ScopeLevel | null {
    const own = levelScopes(levels);
    const held = new Set(expandPermissions(scopes).filter((scope) => own.has(scope)));
    if (held.size === 0) return "none";
    const of = (list: readonly Permission[]) =>
        new Set(expandPermissions(list).filter((scope) => own.has(scope)));
    if (sameSet(held, of(levels.read))) return "read";
    if (sameSet(held, of(levels.write))) return "write";
    return null;
}

/** `selected` with this app set to `level`; every other scope is kept as it was. */
export function withLevel(
    selected: readonly Permission[],
    levels: ScopeLevels,
    level: ScopeLevel
): Permission[] {
    const own = levelScopes(levels);
    const kept = selected.filter((scope) => !own.has(scope));
    const added = level === "none" ? [] : level === "read" ? levels.read : levels.write;
    return [...kept, ...added.filter((scope) => !kept.includes(scope))];
}
