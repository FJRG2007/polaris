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
import { describeDevice, parseSecondFactor, parseSignInMethod, type SignInRecord } from "@polaris/core";

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
    readonly approval: "approved" | "pending" | "denied";
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

const APPROVALS: ReadonlySet<string> = new Set(["approved", "pending", "denied"]);

type SessionRow = Awaited<ReturnType<typeof sessionRowsAt>>[number];

/** The counts being accumulated, before they are handed out as read-only. */
interface AccountSignIns {
    signIns: { accepted: number; refused: number; awaiting: number };
    lastAt: string;
}

/**
 * Every stored session opened from, or last seen at, this address.
 *
 * Both columns are matched because they hold different moments: better-auth
 * writes the address once when the session is created and never follows it,
 * while Polaris's own record is re-stamped whenever the session is evaluated
 * from somewhere new. A session that started at this address and moved, and one
 * that moved to it, are both sessions this address has held.
 */
async function sessionRowsAt(ip: string) {
    return prisma.session.findMany({
        where: { OR: [{ ipAddress: ip }, { state: { is: { ip } } }] },
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

function toAddressSession(row: SessionRow, now: number): AddressSession {
    const approval = row.state?.approval ?? "approved";
    return {
        id: row.id,
        // Polaris's own copy of the user-agent first: better-auth's column is
        // written when the session opens and never followed after that.
        device: describeDevice(row.state?.userAgent ?? row.userAgent, row.state?.userAgentBrands),
        host: row.state?.host ?? null,
        country: row.state?.country ?? null,
        live: row.expiresAt.getTime() > now,
        approval: (APPROVALS.has(approval) ? approval : "approved") as AddressSession["approval"],
        signIn: {
            method: parseSignInMethod(row.state?.signInMethod),
            secondFactor: parseSecondFactor(row.state?.secondFactor)
        },
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
 */
async function signInsAt(ip: string): Promise<Map<string, AccountSignIns>> {
    const groups = await prisma.auditLog.groupBy({
        by: ["actorId", "action"],
        where: { ipHash: auditIpHash(ip), actorId: { not: null }, action: { in: SIGN_IN_ACTIONS } },
        _count: { _all: true },
        _max: { at: true }
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
 */
export async function accountsAtAddress(ip: string, now = Date.now()): Promise<AddressAccount[]> {
    const [rows, signIns] = await Promise.all([sessionRowsAt(ip), signInsAt(ip)]);
    const ids = [...new Set([...rows.map((row) => row.userId), ...signIns.keys()])];
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
