/**
 * The user's own session list: what is signed in, from where, and what to do
 * about it - and, for a browser the account stopped asking for a code, what else
 * that same browser holds. Every read and write is scoped by the owning user, so
 * one account can never see or end another's sessions.
 *
 * Device names come from the stored user-agent. That string is client-supplied
 * and can say anything, so it is only ever used as a label - never as an input to
 * a decision - and is rendered as a short summary rather than echoed raw. It is
 * also what groups one device's things together, which is a comparison between
 * two claims and is presented as one.
 */

import { auth } from "@/lib/auth";
import { prisma } from "@polaris/db";
import { cookies } from "next/headers";
import { recordAudit } from "@/lib/audit-service";
import { networkPublicIp } from "@/lib/network-service";
import { listUserPasskeys, type PasskeyView } from "@/lib/passkey-directory";
import { describeDevice, isIpv4, isPrivateIp, type SignInRecord } from "@polaris/core";
import {
    clientHost,
    clientIp,
    clientUserAgent,
    clientUserAgentBrands
} from "@/lib/request-context";
import {
    sessionApproval,
    sessionSignIn,
    sessionUserAgent,
    type SessionApproval
} from "@/lib/session-row";
import {
    adoptTrustedDevice,
    currentTrustedDevice,
    listTrustedDevices,
    TRUST_DEVICE_COOKIE_NAMES,
    verifyQuickPin,
    type TrustedDeviceView
} from "@polaris/auth";

export interface SessionView {
    id: string;
    /** Whether this is the session making the request. */
    current: boolean;
    approval: SessionApproval;
    locked: boolean;
    device: string;
    ip: string | null;
    /** The address this network reaches the internet from, set only when `ip` is
     *  a local one. A row that says 192.168.1.131 and nothing else cannot be
     *  connected with the rows for the same device seen from outside. */
    publicIp: string | null;
    country: string | null;
    /** Which of this deployment's names the session was opened on, when it was
     *  recorded. Null for sessions older than the column. */
    host: string | null;
    /** How this session proved who it was. Both halves are null on a session
     *  opened before Polaris recorded it, which reads as unknown rather than as
     *  a sign-in that skipped everything. */
    signIn: SignInRecord;
    lastSeenAt: string;
    createdAt: string;
    expiresAt: string;
}

/** One line describing where a sign-in came from, for a notification body. */
export function describeOrigin(
    ip: string | undefined | null,
    country: string | null,
    userAgent: string | undefined | null,
    brands?: string | null
): string {
    const device = describeDevice(userAgent, brands);
    const where = [ip || null, country].filter(Boolean).join(" - ");
    return where ? `${device} - ${where}` : device;
}

/** Every live session a user holds, newest first, as stored. */
async function liveSessionRows(userId: string) {
    return prisma.session.findMany({
        where: { userId, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            createdAt: true,
            expiresAt: true,
            ipAddress: true,
            userAgent: true,
            state: true
        }
    });
}

type SessionRow = Awaited<ReturnType<typeof liveSessionRows>>[number];

/**
 * The address this network is seen at from outside, but only when a list holds
 * something it applies to.
 *
 * A local address is the whole truth about where a device is and says nothing
 * about where it is on the internet, so it is paired with the public one - and
 * a list with no local address in it never pays for the lookup.
 *
 * A failure costs the second address and nothing else. This is the page somebody
 * opens when they think their account is being used by somebody else, and it
 * refusing to draw because a detail could not be resolved would be the worst
 * possible moment for it.
 */
async function pairedPublicIp(addresses: readonly (string | null)[]): Promise<string | null> {
    if (!addresses.some((ip) => ip && isLocalAddress(ip))) return null;
    return networkPublicIp().catch(() => null);
}

/** Whether an address is one only this network can reach. Deliberately narrow:
 *  a value that is not an IPv4 literal at all gets no public address hung off
 *  it, since an unparsed string is not evidence of anything. */
function isLocalAddress(ip: string): boolean {
    return isIpv4(ip) && isPrivateIp(ip);
}

function toSessionView(
    row: SessionRow,
    currentSessionId: string,
    publicIp: string | null
): SessionView {
    const ip = row.state?.ip ?? row.ipAddress;
    return {
        id: row.id,
        current: row.id === currentSessionId,
        approval: sessionApproval(row.state?.approval),
        locked: row.state?.lockedAt != null,
        device: describeDevice(sessionUserAgent(row), row.state?.userAgentBrands),
        ip,
        publicIp: ip && isLocalAddress(ip) ? publicIp : null,
        country: row.state?.country ?? null,
        host: row.state?.host ?? null,
        signIn: sessionSignIn(row.state),
        lastSeenAt: (row.state?.lastSeenAt ?? row.createdAt).toISOString(),
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString()
    };
}

/**
 * Every live session for a user, newest first, with the current one flagged.
 *
 * Everything the account holds, not everything on one address: a deployment
 * answers on several names and the cookie is host-only, so the same person is
 * usually signed in more than once and every one of those is theirs to see.
 *
 * `currentSessionId` only decides which row is labelled, so an administrator
 * reading somebody else's list passes their own and gets no match, which is
 * exactly right - none of those sessions is the one they are reading from.
 */
export async function listUserSessions(
    userId: string,
    currentSessionId: string
): Promise<SessionView[]> {
    const rows = await liveSessionRows(userId);
    const publicIp = await pairedPublicIp(rows.map((row) => row.state?.ip ?? row.ipAddress));
    return rows.map((row) => toSessionView(row, currentSessionId, publicIp));
}

/**
 * What each of a user's live sessions is called, by session id.
 *
 * The label only, for the screens that name a session beside something else -
 * the activity log says which device an entry came from. Kept apart from the
 * list above so naming a session costs one query and never the address lookup a
 * full row pays for. A session that has since ended is simply absent, which is
 * how the caller knows to say so.
 */
export async function sessionDeviceLabels(userId: string): Promise<Map<string, string>> {
    const rows = await liveSessionRows(userId);
    return new Map(
        rows.map((row) => [
            row.id,
            describeDevice(sessionUserAgent(row), row.state?.userAgentBrands)
        ])
    );
}

/**
 * How one session proved who it was, for the code that has to hand that on.
 *
 * Arming or dropping an authenticator replaces the session it was done from, and
 * the replacement is the same person, still signed in the way they signed in - so
 * the record has to travel with them or the screen that says where sessions came
 * from would lose the one the reader is sitting at.
 */
export async function sessionSignInRecord(
    userId: string,
    sessionId: string
): Promise<SignInRecord> {
    const state = await prisma.sessionState.findFirst({
        where: { sessionId, userId },
        select: { signInMethod: true, secondFactor: true }
    });
    return sessionSignIn(state);
}

/**
 * A browser allowed to skip the second-factor challenge for thirty days, as the
 * account page shows it.
 *
 * Deliberately the same shape a session is described in - the same label from
 * the same user-agent, the same address and domain - because to the person
 * reading the page these are the same devices in two lists, and two vocabularies
 * for one laptop is how a security screen stops being read.
 */
export interface TrustedDeviceRow {
    id: string;
    current: boolean;
    device: string;
    ip: string | null;
    /** The address this network reaches the internet from, when `ip` is local. */
    publicIp: string | null;
    host: string | null;
    /** Null for a pass granted before Polaris recorded what the device was. */
    rememberedAt: string | null;
    lastSeenAt: string | null;
    expiresAt: string;
}

/**
 * Every pass this account holds, newest first, with the one this browser is
 * using flagged.
 *
 * The flag is read from the request's own cookie, so it only ever means "the
 * screen you are looking at" - an administrator reading another account's page
 * would match nothing, which is right.
 *
 * The same cookie is what lets a nameless pass be named: the browser holding it
 * is the one asking for this page, so before the list is built it is offered the
 * description its own request carries. Nothing else can name a pass granted
 * before Polaris described them - the rest wait until they are next signed in
 * with.
 */
export async function listTrustedDeviceRows(userId: string): Promise<TrustedDeviceRow[]> {
    const devices = await trustedDeviceViews(userId);
    const publicIp = await pairedPublicIp(devices.map((device) => device.ip));
    return devices.map((device) => toTrustedDeviceRow(device, publicIp));
}

/** The passes this account holds, with the one this browser is on resolved and
 *  described. Kept apart from the mapping above because the raw user-agent goes
 *  no further than this module, and matching a device needs it. */
async function trustedDeviceViews(userId: string): Promise<TrustedDeviceView[]> {
    const jar = await cookies();
    const held = TRUST_DEVICE_COOKIE_NAMES.map((name) => jar.get(name)?.value).find(Boolean);
    const current = currentTrustedDevice(held, userId);
    if (current) {
        const [userAgent, userAgentBrands, ip, host] = await Promise.all([
            clientUserAgent(),
            clientUserAgentBrands(),
            clientIp(),
            clientHost()
        ]);
        await adoptTrustedDevice(userId, current, { userAgent, userAgentBrands, ip, host });
    }
    return listTrustedDevices(userId, current);
}

function toTrustedDeviceRow(device: TrustedDeviceView, publicIp: string | null): TrustedDeviceRow {
    return {
        id: device.id,
        current: device.current,
        device: describeDevice(device.userAgent, device.userAgentBrands),
        ip: device.ip,
        publicIp: device.ip && isLocalAddress(device.ip) ? publicIp : null,
        host: device.host,
        rememberedAt: device.rememberedAt,
        lastSeenAt: device.lastSeenAt,
        expiresAt: device.expiresAt
    };
}

/**
 * One remembered device and everything this account holds on it: the pass
 * itself, the sessions open on it, and the passkeys it registered.
 *
 * The three are held together by the browser's own description of itself,
 * because it is the only thing the same device presents on every one of this
 * deployment's names. A session cookie is host-only and a passkey is bound to
 * one address, so the laptop signed in on polaris.local and on the domain is two
 * sessions and possibly two credentials, and a person deciding what to take away
 * from a device they no longer have needs all of it in one place rather than
 * spread across two screens by an accident of hostnames.
 *
 * The match is exact and it is a match on a claim: two machines running the same
 * browser on the same operating-system version report themselves identically and
 * are grouped as one device here. That is the direction worth erring in - this
 * exists to take access away, and taking away one session too many costs a
 * sign-in, while missing one leaves the device that was lost signed in. The
 * screen says so rather than presenting the grouping as a fact.
 */
export interface TrustedDeviceDetail {
    device: TrustedDeviceRow;
    /** False when the pass carries no description, so nothing can be attributed
     *  to it. The pass can still be ended, which is the point of listing it. */
    identified: boolean;
    /** Every live session opened by this browser, on every name Polaris answers
     *  on - which is the whole reason this is not a filter of one host. */
    sessions: SessionView[];
    passkeys: PasskeyView[];
}

export async function trustedDeviceDetail(
    userId: string,
    currentSessionId: string,
    identifier: string
): Promise<TrustedDeviceDetail | null> {
    const view = (await trustedDeviceViews(userId)).find((device) => device.id === identifier);
    if (!view) return null;
    const userAgent = view.userAgent;
    if (!userAgent) {
        const device = toTrustedDeviceRow(view, await pairedPublicIp([view.ip]));
        return { device, identified: false, sessions: [], passkeys: [] };
    }

    const [rows, passkeys] = await Promise.all([
        liveSessionRows(userId),
        listUserPasskeys(userId, userAgent)
    ]);
    const matched = rows.filter((row) => sessionUserAgent(row) === userAgent);
    const publicIp = await pairedPublicIp([
        view.ip,
        ...matched.map((row) => row.state?.ip ?? row.ipAddress)
    ]);
    return {
        device: toTrustedDeviceRow(view, publicIp),
        identified: true,
        sessions: matched.map((row) => toSessionView(row, currentSessionId, publicIp)),
        passkeys
    };
}

/**
 * End every session this browser has open, on every name it opened one on.
 *
 * The current session is not spared. Signing a device out is the thing somebody
 * reaches for about the device in their hand as readily as about the one they
 * lost, and refusing to include the session they are reading from would leave
 * exactly the session they meant to end. The caller is told it happened so it
 * can drop the cookie and send them to sign in again.
 */
export async function revokeDeviceSessions(
    userId: string,
    currentSessionId: string,
    identifier: string
): Promise<{ count: number; endedCurrent: boolean }> {
    const detail = await trustedDeviceDetail(userId, currentSessionId, identifier);
    if (!detail || detail.sessions.length === 0) return { count: 0, endedCurrent: false };
    const ids = detail.sessions.map((session) => session.id);
    const { count } = await prisma.session.deleteMany({ where: { userId, id: { in: ids } } });
    if (count > 0) {
        await recordAudit({
            actorId: userId,
            action: "account.session.revoked-device",
            metadata: { count, device: detail.device.device }
        });
    }
    return { count, endedCurrent: ids.includes(currentSessionId) };
}

/** End one of the caller's own sessions. */
export async function revokeUserSession(userId: string, sessionId: string): Promise<void> {
    const result = await prisma.session.deleteMany({ where: { id: sessionId, userId } });
    if (result.count > 0) {
        await recordAudit({
            actorId: userId,
            action: "account.session.revoked",
            targetType: "session",
            targetId: sessionId
        });
    }
}

/** End every session except the caller's own. Returns how many were ended. */
export async function revokeOtherSessions(
    userId: string,
    currentSessionId: string
): Promise<number> {
    const result = await prisma.session.deleteMany({
        where: { userId, id: { not: currentSessionId } }
    });
    if (result.count > 0) {
        await recordAudit({
            actorId: userId,
            action: "account.session.revoked-others",
            metadata: { count: result.count }
        });
    }
    return result.count;
}

/**
 * Approve or refuse a pending sign-in from an already-trusted session. A refusal
 * ends the waiting session immediately rather than leaving it parked, so a
 * rejected attempt holds nothing.
 *
 * Letting somebody in is the direction that needs proof, so it asks for the
 * quick-unlock PIN - an open dashboard someone walked up to should not be enough.
 * Refusing needs no PIN: it only ever closes a door.
 */
export async function decideLoginApproval(
    userId: string,
    sessionId: string,
    approve: boolean,
    pin?: string
): Promise<{ error?: string }> {
    const state = await prisma.sessionState.findFirst({
        where: { sessionId, userId, approval: "pending" },
        select: { sessionId: true }
    });
    if (!state) return { error: "That sign-in is no longer waiting." };

    if (approve) {
        if (!(await verifyQuickPin(auth, userId, String(pin ?? "")))) {
            return { error: "That PIN is not right." };
        }
        await prisma.sessionState.update({
            where: { sessionId },
            data: { approval: "approved", lastSeenAt: new Date() }
        });
    } else {
        await prisma.session.deleteMany({ where: { id: sessionId, userId } });
    }
    await recordAudit({
        actorId: userId,
        action: approve ? "account.signin.approved" : "account.signin.denied",
        targetType: "session",
        targetId: sessionId
    });
    return {};
}
