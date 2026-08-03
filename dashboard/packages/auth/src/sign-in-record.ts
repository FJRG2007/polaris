/**
 * What a sign-in proved, on its way to the session it produced.
 *
 * One sign-in is several requests. better-auth creates the session while it
 * answers the credential, Polaris writes the session's own row on that session's
 * first request, and a second factor puts one or two more requests in between -
 * the code that is sent, and the code that is checked. Each of them knows one
 * piece of the answer and none of them knows all of it, so each leaves what it
 * learned on the account and the session collects it when its row is written.
 *
 * The note is deliberately per-account rather than per-session: at the moment the
 * first factor is answered there is either no session yet or one that is about to
 * be taken back, so there is nothing to key it to. What keeps that honest is that
 * it is overwritten at the start of every sign-in, cleared by the session that
 * collects it, and ignored once stale - so the worst a leftover note can do is go
 * uncollected, never label a session it did not belong to.
 *
 * Nothing here may fail a sign-in. A record that could not be written costs a
 * label on a screen; a sign-in that failed because of it costs the account.
 */

import { prisma } from "@polaris/db";
import { upsertSecurity } from "./security.js";
import { parseSecondFactor, parseSignInMethod, type SecondFactor, type SignInRecord } from "@polaris/core";

/**
 * How long a note stays collectable.
 *
 * It has to outlive a second-factor challenge, whose code better-auth gives ten
 * minutes, plus the navigation that follows it. Past that the sign-in it
 * described was abandoned, and an abandoned sign-in must not name a session that
 * began some other way.
 */
const NOTE_TTL_MS = 15 * 60 * 1000;

/** The factors that mean "a code Polaris sent", whichever channel carried it. */
const SENT_CODES: ReadonlySet<SecondFactor> = new Set(["email-code", "whatsapp-code", "code"]);

/** Whatever went wrong, the sign-in itself stands. */
function swallow(what: string): (error: unknown) => void {
    return (error: unknown) => console.error(`${what}:`, error);
}

/**
 * Note a sign-in that has just been answered.
 *
 * Called at the moment the credential checks out, which for an account with the
 * challenge armed is before anyone knows whether the challenge will be raised.
 * That is why a password sign-in on such an account is noted as having skipped it
 * on a remembered browser: if a challenge does follow, answering it overwrites
 * this, and if the sign-in is abandoned the note expires uncollected. The only
 * way this survives to a session is the way it describes.
 */
export async function noteSignIn(userId: string, record: SignInRecord): Promise<void> {
    await upsertSecurity(userId, {
        pendingSignInMethod: record.method,
        pendingSignInFactor: record.secondFactor,
        pendingSignInAt: new Date()
    }).catch(swallow("sign-in not recorded"));
}

/**
 * Note what answered the second-factor challenge, leaving the first factor as it
 * was - the request that proves the second one carries nothing about the first.
 */
export async function noteSecondFactor(userId: string, factor: SecondFactor): Promise<void> {
    await upsertSecurity(userId, {
        pendingSignInFactor: factor,
        pendingSignInAt: new Date()
    }).catch(swallow("second factor not recorded"));
}

/**
 * Note that a code Polaris sent was accepted.
 *
 * Which channel carried it is settled when it goes out and is recorded there, so
 * this keeps that note and only falls back to naming the channel generically when
 * there is none - a code sent before Polaris recorded any of this.
 */
export async function noteSentCodeAnswered(userId: string): Promise<void> {
    const noted = await prisma.userSecurity
        .findUnique({ where: { userId }, select: { pendingSignInFactor: true } })
        .catch(() => null);
    const channel = parseSecondFactor(noted?.pendingSignInFactor);
    await noteSecondFactor(userId, channel && SENT_CODES.has(channel) ? channel : "code");
}

/**
 * Collect the note left by the sign-in that opened a session, and clear it.
 *
 * Cleared whether or not anything was collectable, so one note is spent by one
 * session: two browsers signing the same account in at the same moment is the
 * way this loses, and the cost of losing it is one session labelled the way the
 * other one signed in - never a session labelled as somebody else's.
 */
export async function takeSignInRecord(userId: string): Promise<SignInRecord> {
    const row = await prisma.userSecurity
        .findUnique({
            where: { userId },
            select: { pendingSignInMethod: true, pendingSignInFactor: true, pendingSignInAt: true }
        })
        .catch(() => null);
    if (!row?.pendingSignInAt) return { method: null, secondFactor: null };

    await prisma.userSecurity
        .update({
            where: { userId },
            data: { pendingSignInMethod: null, pendingSignInFactor: null, pendingSignInAt: null }
        })
        .catch(swallow("sign-in note not cleared"));

    if (Date.now() - row.pendingSignInAt.getTime() > NOTE_TTL_MS) return { method: null, secondFactor: null };
    return {
        method: parseSignInMethod(row.pendingSignInMethod),
        secondFactor: parseSecondFactor(row.pendingSignInFactor)
    };
}

/**
 * Hand a session's record to whatever replaces it.
 *
 * Arming or dropping an authenticator replaces the session it was done from -
 * better-auth issues a new one and deletes the old - and the replacement is the
 * same person on the same device, still signed in the way they signed in. Without
 * this it would read as a session that arrived from nowhere, on the very screen
 * that exists to say where sessions came from.
 */
export async function carrySignInRecord(userId: string, record: SignInRecord): Promise<void> {
    if (!record.method && !record.secondFactor) return;
    await noteSignIn(userId, record);
}
