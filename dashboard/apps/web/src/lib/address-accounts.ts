/**
 * Which accounts an address has been seen on.
 *
 * The firewall can say what an address asked for; this answers the question that
 * follows it. A route flood from an address nobody signs in from is a stranger,
 * and the same flood from the address somebody is signed in from is usually that
 * person's machine or their stolen session - and those want opposite responses.
 *
 * Two records are read, because they fail in opposite directions. Session rows
 * say what is open right now, but they are deleted the moment a session ends, so
 * they cannot describe an attempt that never became one. The activity log keeps
 * the sign-ins - including the ones an account's network rules refused - and
 * outlives the sessions, but it holds only a hash of the address, so it can be
 * asked about one address and never listed by address at all.
 *
 * Deliberately not narrowed to the window the traffic panel is being read over.
 * A session opened last week and still open is the single most useful thing to
 * know about an address that is attacking the instance today.
 */

import { prisma } from "@polaris/db";
import { auditIpHash } from "@/lib/audit-service";
import { describeDevice, type SignInRecord } from "@polaris/core";
import { sessionApproval, sessionSignIn, sessionUserAgent, type SessionApproval } from "@/lib/session-row";

/** One session that address opened, live or since expired. */
export interface AddressSession {
    readonly id: string;
    readonly device: string;
    /** Which of this deployment's names it was opened on, when recorded. */
    readonly host: string | null;
    readonly country: string | null;
    /** Whether it is still usable. An expired row is kept until it is cleaned
     *  up, and "was signed in from here" is half of what is being asked. */
    readonly live: boolean;
    /** Waiting for the account to approve it, or already refused. */
    readonly approval: SessionApproval;
    readonly signIn: SignInRecord;
    readonly startedAt: string;
    readonly lastSeenAt: string;
}

/** How the sign-ins this address attempted for one account turned out. */
export interface AddressSignIns {
    readonly accepted: number;
    /** Refused by the account's own network rules before a session existed. */
    readonly refused: number;
    /** Let no further than a pending approval on another device. */
    readonly awaiting: number;
}

/** One account this address has been seen on. */
export interface AddressAccount {
    readonly id: string;
    readonly name: string;
    readonly email: string;
    readonly image: string | null;
    readonly banned: boolean;
    /** Newest first. Live and expired both, expired ones marked. */
    readonly sessions: readonly AddressSession[];
    /** How many of those are still usable. */
    readonly live: number;
    readonly signIns: AddressSignIns;
    /** The most recent thing this address is known to have done to the account. */
    readonly lastAt: string;
}

/** The sign-in outcomes the activity log records, in the order they are counted. */
const SIGN_IN_ACTIONS = ["account.signin", "account.signin.blocked", "account.signin.awaiting-approval"];

/** Enough sessions to describe any real address. A NAT gateway carrying more
 *  than this is already answered by the accounts, not by every row behind them. */
const SESSION_LIMIT = 200;

/** Enough accounts to answer "is this one of ours?". An office gateway every
 *  member signs in through is the ordinary case for a self-hosted deployment, and
 *  the answer there is the first few names and how recently each was seen - not
 *  the whole directory carried to a browser to draw six rows from. */
const ACCOUNT_LIMIT = 50;

type SessionRow = Awaited<ReturnType<typeof sessionRowsAt>>[number];

/** The counts being accumulated, before they are handed out as read-only. */
interface AccountSignIns {
    signIns: { accepted: number; refused: number; awaiting: number };
    lastAt: string;
}

/** Newest first and bounded, so the union of the two reads below can be cut to
 *  the same ceiling and still be the newest sessions the address has held. */
async function sessionRowsMatching(where: { ipAddress: string } | { state: { is: { ip: string } } }) {
    return prisma.session.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: SESSION_LIMIT,
        select: {
            id: true,
            userId: true,
            createdAt: true,
            expiresAt: true,
            userAgent: true,
            state: {
                select: {
                    approval: true,
                    country: true,
                    host: true,
                    lastSeenAt: true,
                    secondFactor: true,
                    signInMethod: true,
                    userAgent: true,
                    userAgentBrands: true
                }
            }
        }
    });
}

/**
 * Every stored session opened from, or last seen at, this address.
 *
 * Both columns are matched because they hold different moments: better-auth
 * writes the address once when the session is created and never follows it,
 * while Polaris's own record is re-stamped whenever the session is evaluated
 * from somewhere new. A session that started at this address and moved, and one
 * that moved to it, are both sessions this address has held.
 *
 * Asked as two questions rather than one `OR`, because the second half is a
 * lookup in another table: an index and a subquery cannot be combined into one
 * read, so a single query matching either would give up on the index for the
 * column that has one and scan every session ever opened. Sessions are only ever
 * deleted one at a time, when somebody signs out or is signed out, so that scan
 * grows for the life of the instance. Two indexed reads merged here do not.
 */
async function sessionRowsAt(ip: string) {
    const [opened, moved] = await Promise.all([
        sessionRowsMatching({ ipAddress: ip }),
        sessionRowsMatching({ state: { is: { ip } } })
    ]);
    const byId = new Map(opened.map((row) => [row.id, row]));
    for (const row of moved) byId.set(row.id, row);
    return [...byId.values()]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, SESSION_LIMIT);
}

function toAddressSession(row: SessionRow, now: number): AddressSession {
    return {
        id: row.id,
        device: describeDevice(sessionUserAgent(row), row.state?.userAgentBrands),
        host: row.state?.host ?? null,
        country: row.state?.country ?? null,
        live: row.expiresAt.getTime() > now,
        approval: sessionApproval(row.state?.approval),
        signIn: sessionSignIn(row.state),
        startedAt: row.createdAt.toISOString(),
        lastSeenAt: (row.state?.lastSeenAt ?? row.createdAt).toISOString()
    };
}

/**
 * The sign-ins this address attempted, per account.
 *
 * Grouped in the database rather than listed and folded here: an address that
 * has been hammering one account for a week has thousands of these, and the only
 * thing worth carrying back is how many and when the last one was.
 *
 * Most recent first and bounded, because the groups are per account and outcome
 * and an address every member of an instance signs in through has one of each
 * for all of them. Three outcomes are counted, so the ceiling is taken three
 * times over to leave the accounts nearest the limit whole rather than holding a
 * name whose refusals fell off the end.
 */
async function signInsAt(ip: string): Promise<Map<string, AccountSignIns>> {
    const groups = await prisma.auditLog.groupBy({
        by: ["actorId", "action"],
        where: { ipHash: auditIpHash(ip), actorId: { not: null }, action: { in: SIGN_IN_ACTIONS } },
        _count: { _all: true },
        _max: { at: true },
        orderBy: { _max: { at: "desc" } },
        take: ACCOUNT_LIMIT * SIGN_IN_ACTIONS.length
    });

    const byUser = new Map<string, AccountSignIns>();
    for (const group of groups) {
        if (!group.actorId) continue;
        const entry = byUser.get(group.actorId) ?? {
            signIns: { accepted: 0, refused: 0, awaiting: 0 },
            lastAt: ""
        };
        const count = group._count._all;
        if (group.action === "account.signin") entry.signIns.accepted += count;
        else if (group.action === "account.signin.blocked") entry.signIns.refused += count;
        else entry.signIns.awaiting += count;
        const at = group._max.at?.toISOString() ?? "";
        if (at > entry.lastAt) entry.lastAt = at;
        byUser.set(group.actorId, entry);
    }
    return byUser;
}

/**
 * Every account this address holds a session on, or has signed in to, most
 * recently active first.
 *
 * An account with a live session comes before one with none however long ago
 * either was: the reader is deciding whether to ban the address, and a live
 * session is the thing a ban would cut off.
 *
 * Which is also the order the names are cut off in when there are more than can
 * be carried: whoever is signed in from here now first, newest session first,
 * then whoever held one that has since expired, then whoever only ever signed
 * in, most recent attempt first. What a ban would break is the half worth
 * keeping.
 */
export async function accountsAtAddress(ip: string, now = Date.now()): Promise<AddressAccount[]> {
    const [rows, signIns] = await Promise.all([sessionRowsAt(ip), signInsAt(ip)]);
    const live = rows.filter((row) => row.expiresAt.getTime() > now);
    const ids = [
        ...new Set([...live.map((row) => row.userId), ...rows.map((row) => row.userId), ...signIns.keys()])
    ].slice(0, ACCOUNT_LIMIT);
    if (ids.length === 0) return [];

    const users = await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, email: true, image: true, bannedAt: true }
    });

    const sessions = new Map<string, AddressSession[]>();
    for (const row of rows) {
        const list = sessions.get(row.userId) ?? [];
        list.push(toAddressSession(row, now));
        sessions.set(row.userId, list);
    }

    return users
        .map((user) => {
            const held = sessions.get(user.id) ?? [];
            const seen = signIns.get(user.id);
            return {
                id: user.id,
                name: user.name || user.email,
                email: user.email,
                image: user.image ?? null,
                banned: user.bannedAt !== null,
                sessions: held,
                live: held.filter((session) => session.live).length,
                signIns: seen?.signIns ?? { accepted: 0, refused: 0, awaiting: 0 },
                lastAt: [seen?.lastAt ?? "", ...held.map((session) => session.lastSeenAt)].sort().at(-1) ?? ""
            };
        })
        .sort((a, b) => Number(b.live > 0) - Number(a.live > 0) || b.lastAt.localeCompare(a.lastAt));
}
