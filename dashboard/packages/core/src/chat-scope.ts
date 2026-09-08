/**
 * Which chat a conversation belongs to.
 *
 * Every account has one chat. An organization may ask for a second one of its
 * own - its people talking to each other about its work, kept apart from the
 * conversations they have with everybody else - and that is what a scope is: the
 * organization a direct message or a group belongs to, or null for the ordinary
 * chat everybody shares.
 *
 * The whole of it is this one key. A one-to-one conversation is found by a key
 * built from who is in it, so putting the organization into that key is what
 * makes two people able to hold two conversations at once without either being
 * able to collide with the other. Nothing else needs to know.
 *
 * Pure and here rather than beside the query, because it decides identity: two
 * call sites that build the key differently do not disagree, they create a
 * second conversation and split somebody's history in half.
 */

/**
 * The unique key for the one-to-one conversation between these accounts.
 *
 * Sorted, so it does not matter who started it. Prefixed when the conversation
 * belongs to an organization, so the same two people have one conversation per
 * chat they share and never one that leaks between them.
 *
 * The prefix cannot be produced by an id: `org:` is not a uuid, and the ids are
 * uuids, so an unprefixed key can never be mistaken for a scoped one.
 */
export function dmKeyFor(userIds: readonly string[], orgId: string | null = null): string {
    const key = [...new Set(userIds)].sort().join(":");
    return orgId ? `org:${orgId}:${key}` : key;
}

/** The organization a conversation key belongs to, or null for the shared chat.
 *  The inverse of `dmKeyFor`, for a reader holding a key and no row. */
export function dmKeyOrgId(key: string): string | null {
    if (!key.startsWith("org:")) return null;
    const rest = key.slice("org:".length);
    const cut = rest.indexOf(":");
    return cut > 0 ? rest.slice(0, cut) : null;
}
