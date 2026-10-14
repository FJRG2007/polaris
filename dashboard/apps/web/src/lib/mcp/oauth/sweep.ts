/**
 * The scheduled cleanup behind the OAuth flow.
 *
 * Every row here is also tidied lazily - expired codes when the same grant is
 * approved again, expired tokens when it is refreshed, unused registrations
 * when the next app registers - but each of those only runs when that grant or
 * that endpoint is used again. A connection nobody uses any more, a code
 * nobody exchanged, a registration from an app that never came back, and a
 * disconnected grant would otherwise stay forever. This pass is what bounds
 * them; it removes nothing that could still be presented or shown.
 */

import { prisma } from "@polaris/db";
import { ROTATED_MEMORY_MS } from "./grants";
import { UNUSED_CLIENT_TTL_MS } from "./clients";

const HOUR = 60 * 60 * 1000;
/** A disconnected grant is kept this long, so reconnecting the same app soon
 *  after keeps the address and database rules the person set on it. */
export const REVOKED_GRANT_TTL_MS = 30 * 24 * HOUR;
/** The rate-limit counters the MCP and OAuth endpoints write. The longest
 *  window any of them uses is an hour (registration). */
export const OAUTH_RATE_LIMIT_PREFIXES = [
    "mcp-call:",
    "mcp-change:",
    "mcp-sse-open:",
    "oauth-token:",
    "oauth-revoke:",
    "oauth-register:",
    "oauth-authorize:"
] as const;
const RATE_LIMIT_WINDOW_MS = HOUR;
/** Rows deleted per statement, and statements per table per pass. */
const BATCH = 1000;
const MAX_BATCHES = 20;

export interface OAuthSweepResult {
    readonly codes: number;
    readonly tokens: number;
    readonly grants: number;
    readonly clients: number;
    readonly counters: number;
}

/**
 * Delete rows a bounded batch at a time: `find` names up to `take` of them by
 * id, `remove` deletes those ids.
 */
async function deleteInBatches(
    find: (take: number) => Promise<{ id: string }[]>,
    remove: (ids: string[]) => Promise<{ count: number }>
): Promise<number> {
    let deleted = 0;
    for (let pass = 0; pass < MAX_BATCHES; pass++) {
        const rows = await find(BATCH);
        if (rows.length === 0) break;
        deleted += (await remove(rows.map((row) => row.id))).count;
        if (rows.length < BATCH) break;
    }
    return deleted;
}

export async function sweepOAuth(now: Date = new Date()): Promise<OAuthSweepResult> {
    const at = now.getTime();
    // A code is checked against its expiry when exchanged, so an expired one
    // can never be used; a used one is only kept to catch a replay inside its
    // five minutes.
    const codeWhere = { expiresAt: { lt: now } };
    const codes = await deleteInBatches(
        (take) => prisma.oAuthCode.findMany({ where: codeWhere, select: { id: true }, take }),
        (ids) => prisma.oAuthCode.deleteMany({ where: { id: { in: ids } } })
    );
    // The same rule `issue` applies to one grant, applied to all of them.
    const tokenWhere = {
        OR: [{ expiresAt: { lt: now } }, { usedAt: { lt: new Date(at - ROTATED_MEMORY_MS) } }]
    };
    const tokens = await deleteInBatches(
        (take) => prisma.oAuthToken.findMany({ where: tokenWhere, select: { id: true }, take }),
        (ids) => prisma.oAuthToken.deleteMany({ where: { id: { in: ids } } })
    );
    // A disconnected grant has no tokens or codes left; past its grace it is
    // only a row. Its codes and tokens would cascade with it regardless.
    const grantWhere = { revokedAt: { lt: new Date(at - REVOKED_GRANT_TTL_MS) } };
    const grants = await deleteInBatches(
        (take) => prisma.oAuthGrant.findMany({ where: grantWhere, select: { id: true }, take }),
        (ids) => prisma.oAuthGrant.deleteMany({ where: { id: { in: ids } } })
    );
    // After the grants, so an app whose last grant just went goes in the same
    // pass. Either kind: a registration that was never approved, and a metadata
    // document nobody approved, which is read again if anybody names it.
    const clientWhere = {
        createdAt: { lt: new Date(at - UNUSED_CLIENT_TTL_MS) },
        grants: { none: {} }
    };
    const clients = await deleteInBatches(
        (take) => prisma.oAuthClient.findMany({ where: clientWhere, select: { id: true }, take }),
        (ids) => prisma.oAuthClient.deleteMany({ where: { id: { in: ids }, grants: { none: {} } } })
    );
    // A counter whose window has run out counts nothing; the next request
    // starts a new one either way.
    const counterWhere = {
        windowStart: { lt: new Date(at - RATE_LIMIT_WINDOW_MS) },
        OR: OAUTH_RATE_LIMIT_PREFIXES.map((prefix) => ({ key: { startsWith: prefix } }))
    };
    const counters = await deleteInBatches(
        (take) =>
            prisma.rateLimitCounter.findMany({ where: counterWhere, select: { id: true }, take }),
        (ids) => prisma.rateLimitCounter.deleteMany({ where: { id: { in: ids } } })
    );
    return { codes, tokens, grants, clients, counters };
}
