/**
 * How long a browser has been signing in to an account, and whether that is long
 * enough for it to change the account's protection.
 *
 * The case this exists for is a password that has just been taken. Whoever has
 * it can sign in, and the first thing worth doing with a stolen account is to
 * shut the owner out of it: change the address recovery mail goes to, replace the
 * questions, end the sessions that could have noticed. Every one of those is a
 * door the real owner still had, and every one closes in seconds.
 *
 * So a device newly seen on the account waits. It can read everything and sign
 * itself out; it cannot change anything under Security until it has been around
 * for as long as the account asks. The owner's existing devices are untouched -
 * which is the point, since the owner is the one who still has one.
 *
 * The device the account was opened from is exempt outright, however new the
 * account is. Turning the wait on from the browser that just created the account
 * and being locked out of Security by your own first act is not a protection
 * anyone asked for, and there is nothing for it to protect against: a password
 * cannot have been stolen from an account that has never been signed in to from
 * anywhere else. It is derived rather than flagged - the first device the account
 * ever recorded is the one it was opened from - because nothing ever deletes one
 * of these rows or moves its first sighting, so the earliest is the earliest
 * forever.
 *
 * Off unless the account turns it on. Making a genuine new laptop wait a week is
 * a real cost, and whether it is worth paying depends on what the account holds.
 *
 * A device is identified by what its browser says it is. Two identical machines
 * count as one, a browser that updates itself reads as a device the account has
 * never seen, and anyone able to set a header can claim to be a device that has
 * been here for months. The middle one is the one that costs the owner something,
 * and it cannot be fixed by reading the claim more loosely: the coarsest reading
 * that survives an update - the browser and the operating system - is exactly the
 * reading under which somebody else's Chrome on Windows is the owner's. Telling
 * one machine from another needs something the machine keeps, not something it
 * says, and that is a larger change than this. The rest is worth knowing and not
 * worth fixing here: the
 * claim is read from the session's recorded description rather than from the
 * request in hand, so it is fixed when the session is created and cannot be
 * varied per call, and the worst a forged one does is let somebody who already
 * has the password skip a wait that was never what kept them out.
 */

import { prisma } from "@polaris/db";
import type { DeviceOrigin } from "./two-factor.js";
import { NEW_DEVICE_GRACE_CHOICES } from "@polaris/core";

/** How much of a user-agent is kept. It is a header, so its length is the
 *  caller's to choose, and this one is an index key. A real one is far shorter. */
const MAX_USER_AGENT = 512;

export interface DeviceStanding {
    /** Whether this device may change the account's protection. True whenever
     *  the wait is off, and for every device that has served it. */
    settled: boolean;
    /** The wait this account asks for, in days. 0 when it asks for none. */
    graceDays: number;
    /** When the wait ends. Null when there is nothing to wait for. */
    settlesAt: Date | null;
    /** When this browser was first seen on the account, if it has been. */
    firstSeenAt: Date | null;
}

const SETTLED: DeviceStanding = { settled: true, graceDays: 0, settlesAt: null, firstSeenAt: null };

/**
 * Record that this browser was seen on the account, and when it first was.
 *
 * Called as a session is created, which is the one moment that is certainly a
 * sign-in rather than a page being read. The first sighting is never rewritten,
 * because a device that could restart its own wait by signing in again would be
 * serving no wait at all.
 *
 * Failure is swallowed: this runs inside a sign-in, and a device that could not
 * be recorded must not be the reason a correct sign-in fails.
 */
export async function rememberAccountDevice(userId: string, origin: DeviceOrigin): Promise<void> {
    const userAgent = origin.userAgent?.slice(0, MAX_USER_AGENT);
    if (!userAgent) return;
    try {
        await prisma.accountDevice.upsert({
            where: { userId_userAgent: { userId, userAgent } },
            create: {
                userId,
                userAgent,
                userAgentBrands: origin.userAgentBrands ?? null,
                userAgentPlatform: origin.userAgentPlatform ?? null,
                ip: origin.ip ?? null,
                host: origin.host ?? null
            },
            update: { lastSeenAt: new Date() }
        });
    } catch (error) {
        console.error("account device not recorded:", error);
    }
}

/**
 * The browser the account was opened from: the first one it ever recorded.
 *
 * Ordered by the sighting rather than by the row's own id, because the id says
 * when the row was written and the sighting is what the account is being dated
 * by; the id only settles a tie, so two devices recorded in the same instant
 * still resolve to one answer instead of drifting between calls.
 *
 * Null for an account whose register is empty, which is every account that
 * predates it. That reads as "no device is exempt", which is the safe direction:
 * those accounts are already let through by the rule below that a device with no
 * row is not a new device.
 */
async function foundingDevice(userId: string): Promise<string | null> {
    const first = await prisma.accountDevice.findFirst({
        where: { userId },
        orderBy: [{ firstSeenAt: "asc" }, { id: "asc" }],
        select: { userAgent: true }
    });
    return first?.userAgent ?? null;
}

/**
 * Whether the browser behind a session may change what protects the account.
 *
 * @param userAgent The description recorded against the session, not the one on
 *                  the request being served. A caller that could pick which
 *                  device it was being judged as would only ever pick an old one.
 */
export async function accountDeviceStanding(
    userId: string,
    userAgent: string | null | undefined
): Promise<DeviceStanding> {
    const row = await prisma.userSecurity.findUnique({
        where: { userId },
        select: { newDeviceGraceDays: true }
    });
    const graceDays = row?.newDeviceGraceDays ?? 0;
    if (graceDays <= 0) return SETTLED;

    // A session with no description cannot be placed. It is refused rather than
    // waved through: the account asked for this wait, and "we could not tell"
    // is not evidence that the device has served it.
    const known = userAgent?.slice(0, MAX_USER_AGENT);
    if (!known) return { settled: false, graceDays, settlesAt: null, firstSeenAt: null };

    const [device, founding] = await Promise.all([
        prisma.accountDevice.findUnique({
            where: { userId_userAgent: { userId, userAgent: known } },
            select: { firstSeenAt: true }
        }),
        foundingDevice(userId)
    ]);
    // No row means the session predates the account keeping this register, and
    // every sign-in since has written one. An older session than the feature is
    // not a new device.
    if (!device) return { ...SETTLED, graceDays };

    // The browser the account was opened from serves no wait, whatever it is set
    // to. It has nothing to settle at, because it was never unsettled.
    if (founding === known) {
        return { settled: true, graceDays, settlesAt: null, firstSeenAt: device.firstSeenAt };
    }

    const settlesAt = new Date(device.firstSeenAt.getTime() + graceDays * 24 * 60 * 60 * 1000);
    return {
        settled: settlesAt.getTime() <= Date.now(),
        graceDays,
        settlesAt,
        firstSeenAt: device.firstSeenAt
    };
}

/**
 * The standing of the device behind a session.
 *
 * The description is read from what was recorded against the session rather than
 * from the request being served, so a caller cannot present itself as a device
 * that has already served the wait. Polaris's own copy is preferred over
 * better-auth's for the same reason it is everywhere else: better-auth writes its
 * column once and never follows it.
 */
export async function sessionDeviceStanding(userId: string, sessionId: string): Promise<DeviceStanding> {
    const session = await prisma.session.findFirst({
        where: { id: sessionId, userId },
        select: { userAgent: true, state: { select: { userAgent: true } } }
    });
    // A session that is not there describes nothing, which an account asking for
    // a wait treats as a device it cannot place - and an account asking for none
    // treats as the nothing it is.
    return accountDeviceStanding(userId, session?.state?.userAgent ?? session?.userAgent);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days, written the way a sentence needs them. */
function days(count: number): string {
    return count === 1 ? "1 day" : `${count} days`;
}

/**
 * What a device still serving its wait is told.
 *
 * One sentence in one place: the refusal comes back both from the account's own
 * actions and from the endpoints the browser calls directly, and two wordings for
 * one rule read as two rules.
 */
export function newDeviceWaitMessage(standing: DeviceStanding): string {
    if (standing.settled) return "";
    if (!standing.settlesAt) {
        return "This browser did not say what it is, so it counts as new. Security settings stay locked from here.";
    }
    const left = Math.max(1, Math.ceil((standing.settlesAt.getTime() - Date.now()) / DAY_MS));
    return `This account gives a new device ${days(standing.graceDays)} before it can change security settings. This one has ${days(left)} left.`;
}

/** Set the wait this account asks a new device to serve. */
export async function setNewDeviceGrace(userId: string, days: number): Promise<void> {
    const allowed: readonly number[] = NEW_DEVICE_GRACE_CHOICES;
    const graceDays = allowed.includes(days) ? days : 0;
    await prisma.userSecurity.upsert({
        where: { userId },
        create: { userId, newDeviceGraceDays: graceDays },
        update: { newDeviceGraceDays: graceDays }
    });
}
