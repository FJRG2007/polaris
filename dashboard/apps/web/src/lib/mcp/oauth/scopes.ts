/**
 * What a connected app may be granted.
 *
 * An OAuth scope here is one of the MCP scopes (`lib/mcp/scope-table.ts`): a
 * Polaris permission key (`tasks.read`), or a finer cut of one (`mail.send`)
 * that stands on a permission. Only the ones some available MCP tool actually
 * asks for are offered, so an app that is not installed offers nothing. A
 * scope narrows exactly as a key does: what an app holds at the moment of a
 * call is what was approved, cut down to what its person holds right then.
 */

import { mcpTools, scopesOf } from "@/lib/mcp/catalog";
import {
    LEGACY_SCOPES,
    isLegacyScope,
    isMcpScope,
    orderScopes,
    scopesHeld,
    type McpScope
} from "@/lib/mcp/scope-table";
import type { Permission } from "@polaris/core";

/** Every scope the available MCP tools use, in the table's order. */
export async function mcpScopes(): Promise<McpScope[]> {
    return scopesOf(await mcpTools());
}

/** Longest scope parameter read. Every scope there is fits in well under this. */
const MAX_SCOPE_PARAM = 4096;

/**
 * The scopes an authorization request asked for.
 *
 * Anything that is not a scope this server offers is dropped rather than
 * refused (RFC 6749 section 3.3 lets the server issue less than was asked, and
 * the token response says what was issued) - clients add `openid` or
 * `offline_access` out of habit. A scope that was split since the app last
 * asked is read as what replaced it. A request that names none of ours, or no
 * scope at all, asks for everything on offer, which the consent screen then
 * lets the person narrow.
 */
export function requestedScopes(
    param: string | null | undefined,
    supported: readonly McpScope[]
): McpScope[] {
    const offered = new Set<string>(supported);
    const asked = new Set<McpScope>();
    for (const token of (param ?? "").slice(0, MAX_SCOPE_PARAM).split(/\s+/)) {
        const scope = isMcpScope(token) && isLegacyScope(token) ? LEGACY_SCOPES[token] : token;
        if (scope && offered.has(scope)) asked.add(scope as McpScope);
    }
    if (asked.size === 0) return [...supported];
    return supported.filter((scope) => asked.has(scope));
}

/**
 * What a connected app's permissions can be changed to on the AI assistants
 * page: every scope on offer now, and the old ones it still holds, cut to what
 * the person holds. Not limited to what the app asked for when it connected -
 * a scope added to Polaris since, or one the app did not know to ask for, is
 * the person's to give - but the page marks those, and nothing is added
 * unless the person ticks it.
 */
export function editableScopes(
    held: readonly McpScope[],
    supported: readonly McpScope[],
    permissions: readonly Permission[]
): McpScope[] {
    const legacy = held.filter((scope) => isMcpScope(scope) && isLegacyScope(scope));
    return scopesHeld(orderScopes([...supported, ...legacy]), permissions);
}

/** A space-separated scope string, the way OAuth writes one. */
export function scopeString(scopes: readonly string[]): string {
    return scopes.join(" ");
}
