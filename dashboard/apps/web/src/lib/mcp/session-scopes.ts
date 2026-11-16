/**
 * The scopes an agent session gets on top of its fixed ones, from what the
 * person it works for holds right now.
 *
 * Seeing and operating the devices in their places is something a person asks
 * of any assistant ("switch off the dehumidifier"), and a session Polar started
 * for them was refused it: its token carried only the task and agent scopes, so
 * the Places tools were in no list it could load. A change still waits for the
 * person, through the session's own approval prompt for a tool that writes.
 * Cameras and routines stay out: a camera's picture is the inside of a home,
 * and a routine does whatever its owner set it to.
 *
 * Server-only.
 */

import { sessionCan } from "@/lib/session";
import { actingUser } from "@/lib/mcp/acting-user";
import { scopeRequires, type McpScope } from "@/lib/mcp/scope-table";

/** What a session may be lent when its person holds it. */
export const SESSION_HELD_SCOPES: readonly McpScope[] = ["places.read", "places.control"];

/** The scopes above that the session's person holds now; none for an account
 *  nothing should be done in the name of. */
export async function heldSessionScopes(ownerId: string): Promise<McpScope[]> {
    const user = await actingUser(ownerId);
    if (!user) return [];
    const held = await Promise.all(
        SESSION_HELD_SCOPES.map((scope) => sessionCan(user, scopeRequires(scope)))
    );
    return SESSION_HELD_SCOPES.filter((_, index) => held[index]);
}

/**
 * Every scope a session's token carries on this call: the fixed ones its part
 * in a run decides, and the lendable ones above, each kept only while its
 * person holds the permission behind it right now. Read on every call, so a
 * ban or a role that loses `agents.manage` reaches a session already running
 * at once - a token never outlives the permission behind it, as an API key's
 * and a connected app's do not.
 *
 * Null for an account nothing should be done in the name of (banned, switched
 * off, on its way out, or gone): the token then answers nothing at all.
 */
export async function sessionScopes(
    ownerId: string,
    fixed: readonly McpScope[]
): Promise<McpScope[] | null> {
    const user = await actingUser(ownerId);
    if (!user) return null;
    const wanted = [...fixed, ...SESSION_HELD_SCOPES];
    const held = await Promise.all(wanted.map((scope) => sessionCan(user, scopeRequires(scope))));
    return wanted.filter((_, index) => held[index]);
}
