/**
 * What a session's device is called.
 *
 * One reading, in one place. The label comes from a client-supplied user-agent,
 * so it is only ever a description - never an input to a decision - and two
 * screens that derived it differently would name the same laptop two things.
 *
 * Kept apart from the session directory so a screen that needs nothing but the
 * name - the activity feed, the history of answered sign-in codes - does not
 * pull in the passkeys, the remembered devices and the address lookups that a
 * full session row costs.
 */

import { prisma } from "@polaris/db";
import { describeClient, type ClientReading } from "@polaris/core";

/** A session as this module reads it: better-auth's own columns, and Polaris's
 *  copy beside them. Structural, so any narrower select satisfies it. */
export interface DescribableSession {
    readonly userAgent: string | null;
    readonly state?: { readonly userAgent: string | null; readonly userAgentBrands: string | null } | null;
}

/**
 * What a session's client says it is, in full: browser, system and the version
 * of each, where the claim carries one.
 *
 * Polaris's own copy of the user-agent comes first: better-auth writes its
 * column once, when the session opens, and never follows it afterwards.
 */
export function sessionClient(row: DescribableSession): ClientReading {
    return describeClient(row.state?.userAgent ?? row.userAgent, row.state?.userAgentBrands);
}

/** The one-line name, for the screens that show a device as a single string. */
export function sessionDevice(row: DescribableSession): string {
    return sessionClient(row).label;
}

/**
 * What each of a user's live sessions is called, by session id.
 *
 * The label only, for the screens that name a session beside something else - the
 * activity log says which device an entry came from, and the scan history says
 * which one read a code. A session that has since ended is simply absent, which
 * is how the caller knows to say so rather than inventing a name for it.
 */
export async function sessionDeviceLabels(userId: string): Promise<Map<string, string>> {
    const rows = await prisma.session.findMany({
        where: { userId, expiresAt: { gt: new Date() } },
        select: {
            id: true,
            userAgent: true,
            state: { select: { userAgent: true, userAgentBrands: true } }
        }
    });
    return new Map(rows.map((row) => [row.id, sessionDevice(row)]));
}
