/**
 * What a connected app may be granted.
 *
 * An OAuth scope here is a Polaris permission key (`tasks.read`), and only the
 * ones some MCP tool actually asks for. The same model API keys use, so a scope
 * means the same thing on both credentials, and it narrows exactly as a key
 * does: what an app holds at the moment of a call is what was approved, cut down
 * to what its person holds right then.
 */

import { MCP_TOOLS } from "@/lib/mcp/tools";
import { PERMISSIONS, type Permission } from "@polaris/core";

/** Every scope the MCP tools use, in the order the permission model lists them. */
export function mcpScopes(): Permission[] {
    const used = new Set<Permission>();
    for (const tool of MCP_TOOLS) if (tool.scope) used.add(tool.scope);
    return PERMISSIONS.filter((permission) => used.has(permission));
}

/** Longest scope parameter read. Every scope there is fits in well under this. */
const MAX_SCOPE_PARAM = 4096;

/**
 * The scopes an authorization request asked for, as permissions.
 *
 * Anything that is not a scope this server offers is dropped rather than
 * refused (RFC 6749 section 3.3 lets the server issue less than was asked, and
 * the token response says what was issued) - clients add `openid` or
 * `offline_access` out of habit. A request that names none of ours, or no scope
 * at all, asks for everything on offer, which the consent screen then lets the
 * person narrow.
 */
export function requestedScopes(
    param: string | null | undefined,
    supported: readonly Permission[]
): Permission[] {
    const offered = new Set<string>(supported);
    const asked = new Set<Permission>();
    for (const token of (param ?? "").slice(0, MAX_SCOPE_PARAM).split(/\s+/)) {
        if (offered.has(token)) asked.add(token as Permission);
    }
    if (asked.size === 0) return [...supported];
    return supported.filter((scope) => asked.has(scope));
}

/** A space-separated scope string, the way OAuth writes one. */
export function scopeString(scopes: readonly string[]): string {
    return scopes.join(" ");
}
