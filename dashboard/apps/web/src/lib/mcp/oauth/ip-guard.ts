/**
 * Applying a connection's address rule to a call: the MCP endpoint checks it
 * on every request, the token endpoint on every exchange and refresh.
 *
 * The address is the one `clientIp()` resolves - the same trusted resolution
 * the rest of Polaris uses behind its proxy - and is passed in by the caller,
 * never read from a forwarded header here.
 *
 * A refusal is stamped on the grant (at most once a minute, so a client
 * retrying in a loop is not a write per call) and written to the account's
 * activity, which is how the person finds out why their assistant stopped.
 */

import { prisma } from "@polaris/db";
import { continentOf } from "@polaris/core";
import { resolveGeo } from "@/lib/geo-service";
import { presetRanges } from "./preset-ranges";
import { recordAudit } from "@/lib/audit-service";
import { ipPolicyAllows, readIpPolicy } from "./ip-policy";
import { exceptionAllows, exceptionIsEmpty, type NetworkException } from "./network-exception";

const REFUSAL_STAMP_MS = 60 * 1000;
/** Far more sessions than one person holds; the read stays bounded anyway. */
const SESSION_LIMIT = 200;

/** The sentence a refused client is given. Read by a machine and, through it,
 *  by the person, so it names where to change it. */
export const IP_REFUSED_DESCRIPTION =
    // i18n-ignore an OAuth error description, read by the client
    "This connection is not allowed from this IP address. Change where it may connect from under Account > AI assistants in Polaris.";

/** Where this person is signed in to Polaris right now: every live, approved
 *  session, by the address it was last seen at and the one it opened from. */
export async function liveSessionIps(userId: string): Promise<string[]> {
    const rows = await prisma.session.findMany({
        where: { userId, expiresAt: { gt: new Date() } },
        orderBy: { updatedAt: "desc" },
        take: SESSION_LIMIT,
        select: { ipAddress: true, state: { select: { ip: true, approval: true } } }
    });
    const found = new Set<string>();
    for (const row of rows) {
        if (row.state && row.state.approval !== "approved") continue;
        if (row.state?.ip) found.add(row.state.ip);
        if (row.ipAddress) found.add(row.ipAddress);
    }
    return [...found];
}

export interface GuardedGrant {
    readonly id: string;
    readonly userId: string;
    readonly ipPolicy: string | null;
    readonly approvedIp: string | null;
}

/** Whether the grant's rule lets a call from `ip` through. Records a refusal. */
export async function grantAllowsIp(grant: GuardedGrant, ip: string | undefined): Promise<boolean> {
    const policy = readIpPolicy(grant.ipPolicy);
    const allowed = await ipPolicyAllows(policy, ip, {
        approvedIp: grant.approvedIp,
        sessionIps: () => liveSessionIps(grant.userId)
    });
    if (allowed) return true;
    try {
        const stamped = await prisma.oAuthGrant.updateMany({
            where: {
                id: grant.id,
                OR: [
                    { lastRefusedAt: null },
                    { lastRefusedAt: { lt: new Date(Date.now() - REFUSAL_STAMP_MS) } }
                ]
            },
            data: { lastRefusedAt: new Date(), lastRefusedIp: ip ?? null }
        });
        if (stamped.count === 1) {
            await recordAudit({
                actorId: grant.userId,
                action: "account.oauth.ip-refused",
                targetType: "oauthGrant",
                targetId: grant.id,
                metadata: { ip: ip ?? null, rule: policy.mode }
            });
        }
    } catch {
        // The refusal stands whether or not it could be written down.
    }
    return false;
}

/**
 * Whether a call the account's network rules refused is let through by the
 * connection's exception.
 *
 * Honoured only while the account is an administrator's: those rules were
 * imposed by an administrator, and only an administrator may make an exception
 * to them - one set while the account was an administrator's stops counting the
 * moment it no longer is. `knownCountry` is the location the account check
 * already resolved, so it is not looked up twice.
 */
export async function exceptionLetsThrough(
    grant: { readonly isAdmin: boolean; readonly networkException: NetworkException },
    ip: string | undefined,
    knownCountry: string | null
): Promise<boolean> {
    if (!grant.isAdmin || exceptionIsEmpty(grant.networkException)) return false;
    return exceptionAllows(grant.networkException, ip, {
        country: async () => knownCountry ?? (ip ? (await resolveGeo(ip)).countryCode : null),
        presetRanges,
        continentOf
    });
}
