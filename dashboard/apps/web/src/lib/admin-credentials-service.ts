/**
 * What an administrator can do about somebody else's way in: hand them a link to
 * set a new password, give them a temporary one, mail them the link, or move the
 * account to another address.
 *
 * The callers have already proved the administrator (step-up) and parsed the
 * input; this module decides the rest. Every action here is refused on the
 * caller's own account - their own security page is the way to change that, and
 * it asks for the current password - and on an account that outranks the caller.
 * Rank is binary in Polaris today (administrator or not, and only administrators
 * reach this), so the rank check is the same comparison every other guard here
 * would need the day there is a level above.
 *
 * The reset link is the account-recovery ticket the sign-in page already redeems
 * (`/oauth/recover?ticket=`): 256 random bits, stored only as a SHA-256, spent on
 * first use. Issued here it is born approved and short-lived, and issuing a new
 * one retires any the account still held, so there is never more than one live
 * link per account.
 */

import { auth } from "./auth";
import { prisma } from "@polaris/db";
import { recordAudit } from "./audit-service";
import { appBaseUrl } from "./domain-service";
import { rateLimit } from "./rate-limit-service";
import { revokeStepUpGrants } from "./step-up-grant";
import { readerWords } from "@/lib/i18n/reader-words";
import { revokeOtherSessions } from "./session-directory";
import { revokeUserSessions } from "./user-admin-service";
import { wordsFor } from "@/lib/notifications/notice-words";
import { createNotification } from "./notification-service";
import { emailOwner, resetUserPassword } from "@polaris/auth";
import { getAuthMailStatus, sendAuthEmail } from "./auth-mail";
import { generateToken, hashToken } from "@polaris/core/tokens";
import { unacceptablePassword } from "./account-recovery-service";

/** How long an issued link stays redeemable. Long enough to read it out over a
 *  call and for them to open it, short enough that a link left in a chat is dead
 *  by the time anybody else scrolls up to it. */
export const RESET_LINK_TTL_MINUTES = 30;

/** Per administrator, and per account they act on. The second is the one that
 *  matters: it stops one account being flooded with links by several people. */
const ACTOR_LIMIT = 20;
const TARGET_LIMIT = 5;
const WINDOW_MS = 60 * 60 * 1000;

/** What the credentials section can offer for one account. */
export interface CredentialOptions {
    /** Why mailing a reset link is not possible, or null when it is. */
    mailBlocker: "noChannel" | "unverified" | null;
}

type Refusal = { error: string };

async function refusal(key: string): Promise<Refusal> {
    return { error: (await readerWords("admin"))(`usersDetail.errors.${key}` as never) };
}

/** The checks every action shares: the account exists, is not the caller's, is
 *  not above them, and neither side has run out of attempts. */
async function guard(
    actorId: string,
    userId: string
): Promise<Refusal | { target: { email: string; emailVerified: boolean; name: string } }> {
    if (actorId === userId) return refusal("credentialsSelf");
    const [actor, target] = await Promise.all([
        prisma.user.findUnique({ where: { id: actorId }, select: { isAdmin: true } }),
        prisma.user.findUnique({
            where: { id: userId },
            select: { isAdmin: true, email: true, emailVerified: true, name: true }
        })
    ]);
    if (!target) return refusal("unknownAccount");
    if (Number(target.isAdmin) > Number(actor?.isAdmin === true)) return refusal("outranked");
    const [byActor, byTarget] = await Promise.all([
        rateLimit(`admin-credentials:${actorId}`, ACTOR_LIMIT, WINDOW_MS),
        rateLimit(`admin-credentials-target:${userId}`, TARGET_LIMIT, WINDOW_MS)
    ]);
    const limited = !byActor.ok ? byActor : !byTarget.ok ? byTarget : null;
    if (limited) {
        const t = await readerWords("admin");
        return { error: t("usersDetail.errors.tooMany", { minutes: Math.max(1, Math.ceil(limited.retryAfterMs / 60000)) }) };
    }
    return { target };
}

/** Whether a reset link can be mailed to this account, and if not, why. */
export async function credentialOptions(userId: string): Promise<CredentialOptions> {
    const [mail, user] = await Promise.all([
        getAuthMailStatus(),
        prisma.user.findUnique({ where: { id: userId }, select: { emailVerified: true } })
    ]);
    if (!mail.channelId) return { mailBlocker: "noChannel" };
    return { mailBlocker: user?.emailVerified ? null : "unverified" };
}

/** Retire every link the account still holds and write a new one. */
async function writeTicket(actorId: string, userId: string): Promise<{ url: string; expiresAt: Date }> {
    const ticket = generateToken();
    const expiresAt = new Date(Date.now() + RESET_LINK_TTL_MINUTES * 60_000);
    await prisma.$transaction([
        prisma.accountRecovery.updateMany({
            where: { userId, status: { in: ["pending", "approved"] } },
            data: { status: "expired" }
        }),
        prisma.accountRecovery.create({
            data: {
                userId,
                tokenHash: hashToken(ticket),
                verified: true,
                status: "approved",
                decidedById: actorId,
                decidedAt: new Date(),
                expiresAt
            }
        })
    ]);
    return { url: `${await appBaseUrl()}/oauth/recover?ticket=${encodeURIComponent(ticket)}`, expiresAt };
}

/** A one-time link for the account to set its own password. Shown once, to the
 *  administrator, and never stored anywhere but as its hash. */
export async function issueResetLink(
    actorId: string,
    userId: string
): Promise<Refusal | { url: string; expiresAt: string }> {
    const checked = await guard(actorId, userId);
    if ("error" in checked) return checked;
    const { url, expiresAt } = await writeTicket(actorId, userId);
    await recordAudit({
        actorId,
        action: "user.password.reset-link",
        targetType: "user",
        targetId: userId,
        metadata: { expiresAt: expiresAt.toISOString() }
    });
    return { url, expiresAt: expiresAt.toISOString() };
}

/** The same link, mailed to the account's own confirmed address instead of shown. */
export async function mailResetLink(actorId: string, userId: string): Promise<{ error?: string }> {
    const checked = await guard(actorId, userId);
    if ("error" in checked) return checked;
    const { mailBlocker } = await credentialOptions(userId);
    if (mailBlocker) return refusal(mailBlocker === "noChannel" ? "mailNoChannel" : "mailUnverified");
    const { url } = await writeTicket(actorId, userId);
    const t = await wordsFor(userId, "notices");
    const sent = await sendAuthEmail({
        to: checked.target.email,
        subject: t("accountAdmin.resetMail.subject"),
        text: t("accountAdmin.resetMail.body", { url, minutes: RESET_LINK_TTL_MINUTES })
    });
    await recordAudit({
        actorId,
        action: sent.error ? "user.password.reset-mail-failed" : "user.password.reset-mail",
        targetType: "user",
        targetId: userId
    });
    return sent.error ? refusal("mailFailed") : {};
}

/**
 * Give the account a password the administrator chose and will tell them. Every
 * session it holds ends, and the next one is held on the change-password step
 * until the account picks its own (`session-guard`).
 */
export async function setTemporaryPassword(
    actorId: string,
    userId: string,
    password: string
): Promise<{ error?: string }> {
    const refused = await unacceptablePassword(userId, password);
    if (refused) return { error: refused };
    const checked = await guard(actorId, userId);
    if ("error" in checked) return checked;
    const written = await resetUserPassword(auth, userId, password);
    if (written.error) return written;
    await prisma.user.update({ where: { id: userId }, data: { passwordChangeRequired: true } });
    await revokeUserSessions(actorId, userId);
    await revokeStepUpGrants(userId);
    await recordAudit({ actorId, action: "user.password.temporary", targetType: "user", targetId: userId });
    return {};
}

/**
 * Move the account to another sign-in address.
 *
 * The address is normalized before anything compares it, and refused when any
 * account - this one included, as an alternate - already holds it. It starts
 * unconfirmed unless the administrator says they confirmed it themselves. The
 * old address is kept as an unconfirmed alternate when asked, so nothing the
 * account owned disappears silently, and the account is told in the bell.
 */
export async function changeAccountEmail(
    actorId: string,
    userId: string,
    input: { email: string; verified: boolean; keepOld: boolean }
): Promise<{ error?: string }> {
    const checked = await guard(actorId, userId);
    if ("error" in checked) return checked;
    const from = checked.target.email;
    const to = input.email;
    if (to === from) return refusal("emailUnchanged");
    if (await emailOwner(to)) return refusal("emailTaken");

    await prisma.$transaction([
        prisma.user.update({ where: { id: userId }, data: { email: to, emailVerified: input.verified } }),
        ...(input.keepOld ? [prisma.userEmail.create({ data: { userId, email: from, verifiedAt: null } })] : [])
    ]);
    await revokeStepUpGrants(userId);

    const t = await wordsFor(userId, "notices");
    await createNotification({
        userId,
        type: "account.email-changed",
        title: t("accountAdmin.emailChanged.title"),
        body: t("accountAdmin.emailChanged.body", { from, to }),
        href: "/account/details",
        level: "warning"
    });
    // The old inbox hears about it too when Polaris can send mail: it is the one
    // place the owner looks if this was not something they asked for.
    const mail = await getAuthMailStatus();
    if (mail.channelId && checked.target.emailVerified) {
        await sendAuthEmail({
            to: from,
            subject: t("accountAdmin.emailChanged.title"),
            text: t("accountAdmin.emailChanged.body", { from, to })
        }).catch(() => undefined);
    }
    await recordAudit({
        actorId,
        action: "user.email.change",
        targetType: "user",
        targetId: userId,
        metadata: { from, to, verified: input.verified, keptOld: input.keepOld }
    });
    return {};
}

/** Whether this account is still held on the change-password step. */
export async function owesPasswordChange(userId: string): Promise<boolean> {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { passwordChangeRequired: true } });
    return row?.passwordChangeRequired === true;
}

/**
 * The account replacing a temporary password with its own. Only reachable while
 * the hold is set; any other session still signed in on the temporary password
 * ends, because whoever else knew it is exactly who this shuts out.
 */
export async function replaceTemporaryPassword(
    userId: string,
    sessionId: string,
    password: string
): Promise<{ error?: string }> {
    if (!(await owesPasswordChange(userId))) return {};
    const refused = await unacceptablePassword(userId, password);
    if (refused) return { error: refused };
    const written = await resetUserPassword(auth, userId, password);
    if (written.error) return written;
    await prisma.user.update({ where: { id: userId }, data: { passwordChangeRequired: false } });
    await revokeOtherSessions(userId, sessionId);
    await revokeStepUpGrants(userId);
    await recordAudit({ actorId: userId, action: "account.password.replaced-temporary", targetType: "user", targetId: userId });
    return {};
}
