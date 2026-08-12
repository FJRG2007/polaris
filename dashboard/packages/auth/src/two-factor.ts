/**
 * Server-side access to the two-factor plugin's endpoints.
 *
 * The plugin is registered as a plain BetterAuthPlugin (see auth.ts) so this
 * package's emitted declarations stay portable, which costs the inferred types
 * for its endpoints. Rather than spread that gap across call sites, the one
 * endpoint Polaris needs on the server is narrowed here, in the module that owns
 * the auth instance - everywhere else keeps a plain, typed function.
 *
 * Enrollment, disabling, and the sign-in challenge all run through the browser
 * client, which types those paths itself.
 */

import { prisma } from "@polaris/db";
import type { Auth } from "./auth.js";
import { loadEnv } from "@polaris/config";
import { createHmac, timingSafeEqual } from "node:crypto";

interface TwoFactorEndpoints {
    verifyTOTP(input: { body: { code: string }; headers: Headers }): Promise<unknown>;
    generateBackupCodes(input: {
        body: { password: string };
        headers: Headers;
    }): Promise<{ backupCodes?: string[] }>;
    /** Server-only in better-auth: it has no route and no client method, so the
     *  decrypted codes can only ever be reached from trusted server code. */
    viewBackupCodes(input: { body: { userId: string } }): Promise<{ backupCodes?: string[] }>;
}

/**
 * Verify a TOTP code against the signed-in user's authenticator. Used to prove
 * identity for an action the password would otherwise gate (setting a new
 * password after forgetting the old one). A wrong code throws inside better-auth;
 * that is a failed check, not an error worth surfacing.
 */
export async function verifyTotpForSession(auth: Auth, headers: Headers, code: string): Promise<boolean> {
    const api = auth.api as unknown as TwoFactorEndpoints;
    try {
        await api.verifyTOTP({ body: { code }, headers });
        return true;
    } catch {
        return false;
    }
}

/** Whether the user has a verified authenticator armed. */
export async function twoFactorEnabled(userId: string): Promise<boolean> {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { twoFactorEnabled: true } });
    return row?.twoFactorEnabled === true;
}

/**
 * Backup codes: the way in when the authenticator is not to hand.
 *
 * better-auth mints them with the factor, stores them encrypted under this
 * instance's secret, and strikes each one off as it is spent - so the stored set
 * is exactly the codes still worth keeping. Both functions below go through its
 * endpoints rather than reading the column, because the encryption is the
 * library's and a second reader of it would be a second thing to keep in step.
 */

/**
 * How many codes the account has left, or null when there is no set to count -
 * no authenticator armed, or a stored set this instance cannot read.
 *
 * The count only, never the codes. A page that says "3 left" is telling somebody
 * to go and make more; a page that hands the codes back would make every open
 * session a way to read them, which is the one thing they are not meant to be.
 */
export async function backupCodesRemaining(auth: Auth, userId: string): Promise<number | null> {
    const api = auth.api as unknown as TwoFactorEndpoints;
    try {
        const { backupCodes } = await api.viewBackupCodes({ body: { userId } });
        return Array.isArray(backupCodes) ? backupCodes.length : null;
    } catch {
        // Thrown for an account with no two-factor row, which is not a failure -
        // it is what "no codes" looks like from here.
        return null;
    }
}

/**
 * Mint a fresh set, replacing whatever is left of the old one.
 *
 * The password is asked for because this is the control that decides what the
 * account's spare keys are: the codes it returns open the account on their own,
 * and the ones it silently invalidates were somebody's printout. better-auth
 * checks the password itself and answers the same way whether it was wrong or
 * the factor was never armed, so the two are told apart here from what the
 * account actually has rather than from the message.
 *
 * Returned once, to the caller that asked. Nothing stores them and nothing logs
 * them - the encrypted set better-auth wrote is the only copy that survives this
 * call, and it cannot be read back as plaintext by anything but the count above.
 */
export async function regenerateBackupCodes(
    auth: Auth,
    headers: Headers,
    password: string
): Promise<{ codes?: string[]; error?: string }> {
    const api = auth.api as unknown as TwoFactorEndpoints;
    try {
        const { backupCodes } = await api.generateBackupCodes({ body: { password }, headers });
        if (!Array.isArray(backupCodes) || backupCodes.length === 0) {
            return { error: "No codes were issued. Try again." };
        }
        return { codes: backupCodes };
    } catch {
        return { error: "Current password is incorrect." };
    }
}

/**
 * Browsers that answered the challenge and asked to be remembered.
 *
 * better-auth records each one as a verification row keyed by a random
 * identifier and valued with the user id, and reads it back from a cookie before
 * the challenge is raised - so while one stands, that browser signs in with the
 * password alone. That row is the pass, and it is the only thing that decides
 * anything here.
 *
 * It carries nothing but the user id and an expiry, so Polaris keeps a
 * TrustedDevice row beside it saying what the device looked like when it was
 * remembered (see recordTrustedDevice). A pass with no description is still a
 * pass: the list is built from the verification rows and shows an unnamed one
 * rather than hiding it, because a device somebody cannot name is exactly the
 * one they may want to end.
 */
const TRUST_PREFIX = "trust-device-";

/** Where a `trust-device-*` verification row lives, as a Prisma filter. */
function trustFilter(userId: string) {
    return { identifier: { startsWith: TRUST_PREFIX }, value: userId };
}

export async function countTrustedDevices(userId: string): Promise<number> {
    return prisma.verification.count({ where: { ...trustFilter(userId), expiresAt: { gt: new Date() } } });
}

/**
 * Which pass the browser making this request holds, from the cookie it sent.
 *
 * Only so the list can say "this device": a person scanning four entries for the
 * phone they lost needs to know which one is the screen they are looking at.
 *
 * The cookie carries `${token}!${identifier}`, where the token is an HMAC over
 * the user and the identifier under this instance's secret - so it is checked
 * rather than read, on the same terms better-auth checks it before honouring the
 * pass. A forged cookie only ever mislabels a row in the forger's own browser,
 * but a security screen that can be made to lie about which device you are on is
 * not worth the four lines saved.
 */
export function currentTrustedDevice(cookie: string | undefined, userId: string): string | null {
    if (!cookie) return null;
    // The outer signature better-call appends; the value is everything before it.
    const signed = cookie.slice(0, cookie.lastIndexOf("."));
    const [token, identifier] = (signed || cookie).split("!");
    if (!token || !identifier?.startsWith(TRUST_PREFIX)) return null;
    const expected = createHmac("sha256", loadEnv().POLARIS_AUTH_SECRET)
        .update(`${userId}!${identifier}`)
        .digest("base64url");
    const given = Buffer.from(token);
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
    return identifier;
}

/**
 * What a request said about the browser making it, as recorded against a pass.
 *
 * Every field is the caller's to write and is kept as a label. The brands and the
 * platform are carried beside the user-agent because that string is the one a
 * browser rewrites: a Chromium that rebadges Chrome names itself only in the
 * brands, and one emulating a phone keeps its real system only in the platform.
 */
export interface DeviceOrigin {
    userAgent?: string;
    userAgentBrands?: string;
    userAgentPlatform?: string;
    ip?: string;
    host?: string;
}

/** The stored columns for what a request said about itself. Absent is null
 *  rather than left alone, so a re-description never keeps half of an older one
 *  and reads as a device that was never really seen that way. */
function describedBy(origin: DeviceOrigin) {
    return {
        userAgent: origin.userAgent ?? null,
        userAgentBrands: origin.userAgentBrands ?? null,
        userAgentPlatform: origin.userAgentPlatform ?? null,
        ip: origin.ip ?? null,
        host: origin.host ?? null
    };
}

/** One remembered browser, as the account page shows it. */
export interface TrustedDeviceView {
    /** The pass being described. What a revoke names, and what rotates - so it
     *  is a handle for one screenful, not something to store anywhere. */
    id: string;
    /** Whether this is the browser asking. Never revoked by mistake, and it is
     *  the one entry a person can place with certainty. */
    current: boolean;
    /** Raw, for the caller to label; the shapes it can take are a browser's
     *  business, so the parse lives with the rest of the device labelling. */
    userAgent: string | null;
    /** The brands it announced, read together with the user-agent above. */
    userAgentBrands: string | null;
    /** The system it announced, which outranks the user-agent's claim. */
    userAgentPlatform: string | null;
    ip: string | null;
    host: string | null;
    /** Null on a pass granted before Polaris started describing them. */
    rememberedAt: string | null;
    lastSeenAt: string | null;
    expiresAt: string;
}

/**
 * Every pass this account currently holds, newest first.
 *
 * Driven by the verification rows rather than by the descriptions, so a pass
 * Polaris failed to describe - one granted before this existed, or one whose
 * description could not be written - is still listed and still revocable. The
 * opposite arrangement would show a shorter list than the truth, which for a
 * security screen is the one failure that matters.
 *
 * @param currentIdentifier The pass the caller's own browser holds, if any.
 */
export async function listTrustedDevices(
    userId: string,
    currentIdentifier: string | null
): Promise<TrustedDeviceView[]> {
    const passes = await prisma.verification.findMany({
        where: { ...trustFilter(userId), expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
        select: { identifier: true, expiresAt: true }
    });
    if (passes.length === 0) return [];

    const described = await prisma.trustedDevice.findMany({
        where: { userId, identifier: { in: passes.map((pass) => pass.identifier) } }
    });
    const byIdentifier = new Map(described.map((row) => [row.identifier, row]));

    return passes.map((pass) => {
        const details = byIdentifier.get(pass.identifier);
        return {
            id: pass.identifier,
            current: pass.identifier === currentIdentifier,
            userAgent: details?.userAgent ?? null,
            userAgentBrands: details?.userAgentBrands ?? null,
            userAgentPlatform: details?.userAgentPlatform ?? null,
            ip: details?.ip ?? null,
            host: details?.host ?? null,
            rememberedAt: details?.createdAt.toISOString() ?? null,
            lastSeenAt: details?.lastSeenAt.toISOString() ?? null,
            expiresAt: pass.expiresAt.toISOString()
        };
    });
}

/**
 * Stop remembering one browser. Scoped by user id as well as by identifier, so a
 * guessed handle from another account revokes nothing.
 *
 * The description goes with the pass rather than being left behind: it exists
 * only to name a pass, and a name with nothing behind it would show up as a
 * device that is still remembered.
 */
export async function revokeTrustedDevice(userId: string, identifier: string): Promise<boolean> {
    if (!identifier.startsWith(TRUST_PREFIX)) return false;
    const { count } = await prisma.verification.deleteMany({ where: { ...trustFilter(userId), identifier } });
    await prisma.trustedDevice.deleteMany({ where: { userId, identifier } });
    return count > 0;
}

/**
 * Stop remembering every browser at once, so the next sign-in on each asks for a
 * code again. The blunt one, for when a device is out of the owner's hands and
 * working out which entry it is costs time they do not have.
 *
 * Expired rows go with them - they no longer let anyone in, and leaving them
 * would make the count on the page disagree with what it dropped.
 */
export async function revokeTrustedDevices(userId: string): Promise<number> {
    const { count } = await prisma.verification.deleteMany({ where: trustFilter(userId) });
    await prisma.trustedDevice.deleteMany({ where: { userId } });
    return count;
}

/**
 * Describe the pass that was just granted to this browser.
 *
 * The identifier is not handed to us: better-auth mints it inside its own
 * handler and only ever puts it in a cookie. What is certain is that it has just
 * written exactly one new `trust-device-*` row for this user, so the newest one
 * is it. Two devices remembered by the same account in the same instant would be
 * the way that is wrong, and the cost of it is a swapped label.
 *
 * Failure is swallowed: this runs inside the request that is signing somebody
 * in, and a description that could not be written must not be the reason a
 * correct sign-in fails. The pass is listed either way, just without a name.
 */
export async function recordTrustedDevice(userId: string, origin: DeviceOrigin): Promise<void> {
    try {
        const pass = await prisma.verification.findFirst({
            where: { ...trustFilter(userId), expiresAt: { gt: new Date() } },
            orderBy: { createdAt: "desc" },
            select: { identifier: true }
        });
        if (!pass) return;
        await prisma.trustedDevice.upsert({
            where: { identifier: pass.identifier },
            create: { identifier: pass.identifier, userId, ...describedBy(origin) },
            update: describedBy(origin)
        });
    } catch (error) {
        console.error("trusted device not recorded:", error);
    }
}

/**
 * Describe the pass the browser reading the page is holding, when nothing
 * describes it yet.
 *
 * A pass is only ever described at the moment it is minted or spent, so every
 * pass granted before Polaris recorded any of that stays nameless for the rest
 * of its thirty days - a list of "Remembered earlier" rows with no address, no
 * domain and nothing to open. For one of them that is avoidable: the browser
 * holding it is the one asking for the page, and its own request says what it
 * is.
 *
 * Only ever fills a gap. An existing description is left exactly as it was -
 * what a device looked like when it was remembered is the fact worth keeping,
 * not what it looks like now - and a pass that has expired or belongs to nobody
 * gets nothing, so this can never invent a device.
 */
export async function adoptTrustedDevice(
    userId: string,
    identifier: string,
    origin: DeviceOrigin
): Promise<boolean> {
    if (!identifier.startsWith(TRUST_PREFIX)) return false;
    if (!origin.userAgent && !origin.ip && !origin.host) return false;
    try {
        const described = await prisma.trustedDevice.findUnique({
            where: { identifier },
            select: { identifier: true }
        });
        if (described) return false;
        const pass = await prisma.verification.findFirst({
            where: { ...trustFilter(userId), identifier, expiresAt: { gt: new Date() } },
            select: { identifier: true }
        });
        if (!pass) return false;
        await prisma.trustedDevice.create({ data: { identifier, userId, ...describedBy(origin) } });
        return true;
    } catch (error) {
        // Two tabs rendering the page at once is the way this loses; the row the
        // winner wrote is the same one, so there is nothing to repair.
        console.error("trusted device not adopted:", error);
        return false;
    }
}

/**
 * Follow a pass better-auth just rotated.
 *
 * It replaces the identifier on every sign-in the pass admits - old row deleted,
 * new one written - so without this a device would lose its description the
 * first time it was used, which is to say immediately. The old identifier comes
 * from the cookie the request arrived with; the new one is the newest row, by
 * the same reasoning as above.
 *
 * When the old pass has no description - and when it turns out not to have been
 * rotated at all - the moment is still worth recording, so a device remembered
 * before this existed picks up a name the next time it signs in rather than
 * staying nameless for thirty days.
 */
export async function followTrustedDevice(
    userId: string,
    previousIdentifier: string,
    origin: DeviceOrigin
): Promise<void> {
    try {
        const pass = await prisma.verification.findFirst({
            where: { ...trustFilter(userId), expiresAt: { gt: new Date() } },
            orderBy: { createdAt: "desc" },
            select: { identifier: true }
        });
        if (!pass) {
            // The pass was refused and expired rather than rotated; the
            // description now names nothing.
            await prisma.trustedDevice.deleteMany({ where: { userId, identifier: previousIdentifier } });
            return;
        }
        const existing = await prisma.trustedDevice.findUnique({ where: { identifier: previousIdentifier } });
        if (existing && existing.userId === userId) {
            await prisma.trustedDevice.update({
                where: { identifier: previousIdentifier },
                data: {
                    identifier: pass.identifier,
                    ip: origin.ip ?? existing.ip,
                    host: origin.host ?? existing.host,
                    userAgent: origin.userAgent ?? existing.userAgent,
                    userAgentBrands: origin.userAgentBrands ?? existing.userAgentBrands,
                    userAgentPlatform: origin.userAgentPlatform ?? existing.userAgentPlatform,
                    lastSeenAt: new Date()
                }
            });
            return;
        }
        await prisma.trustedDevice.upsert({
            where: { identifier: pass.identifier },
            create: { identifier: pass.identifier, userId, ...describedBy(origin) },
            update: { lastSeenAt: new Date() }
        });
    } catch (error) {
        console.error("trusted device not followed:", error);
    }
}
