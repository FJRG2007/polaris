/**
 * Proving that an address on an account can be read by the person who claimed it.
 *
 * The link is a 256-bit token that lives only in the message; the row keeps its
 * SHA-256, so a database dump yields nothing replayable. Asking again replaces
 * the outstanding link rather than adding a second one, and spending a link
 * deletes it - a verification URL is good exactly once.
 *
 * Verifying an address is deliberately not the same as owning it: an address is
 * added to an account without proof (an operator may want to record one they
 * cannot receive at), and verification is what upgrades it into something the
 * account system will send a reset or a sign-in code to.
 */

import { prisma } from "@polaris/db";
import { sendAuthEmail } from "./auth-mail";
import { appBaseUrl } from "./domain-service";
import { generateToken, hashToken } from "@polaris/core/tokens";

/** How long a verification link stays good. Long enough to survive a mail queue
 *  and a night's sleep, short enough that an old message is not a live key. */
const LINK_TTL_MS = 24 * 60 * 60 * 1000;

/** The address, as it is stored, that this link would prove. */
export interface VerifiedAddress {
    email: string;
    primary: boolean;
}

/** Built on the reachable address rather than the LAN-only name: the link is read
 *  from a mailbox, which may well be opened from outside the network. */
async function verificationUrl(token: string): Promise<string> {
    return `${await appBaseUrl()}/oauth/verify-email?token=${encodeURIComponent(token)}`;
}

function messageBody(url: string): { text: string; html: string } {
    const text = [
        "Confirm this address so Polaris can use it for your account.",
        "",
        url,
        "",
        "The link works once and expires in 24 hours. If you did not ask for this, ignore this message."
    ].join("\n");
    const html = [
        "<p>Confirm this address so Polaris can use it for your account.</p>",
        `<p><a href="${url}">Confirm this address</a></p>`,
        "<p>The link works once and expires in 24 hours. If you did not ask for this, ignore this message.</p>"
    ].join("");
    return { text, html };
}

/**
 * Issue a link for one of the user's own addresses and send it there. Returns
 * the reason it could not be sent, which is nearly always that no email channel
 * is configured - worth saying plainly rather than reporting a silent success.
 */
export async function requestEmailVerification(
    userId: string,
    email: string
): Promise<{ error?: string }> {
    const address = email.trim().toLowerCase();
    const [user, alternate] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true } }),
        prisma.userEmail.findFirst({ where: { userId, email: address }, select: { verifiedAt: true } })
    ]);
    const isPrimary = user?.email.toLowerCase() === address;
    if (!isPrimary && !alternate) return { error: "That address is not on your account." };
    if (isPrimary ? user?.emailVerified : alternate?.verifiedAt !== null) {
        return { error: "That address is already verified." };
    }

    const token = generateToken();
    // One outstanding link per address: asking again invalidates the last one, so
    // an old message in an inbox stops working the moment a new one is sent.
    await prisma.$transaction([
        prisma.emailVerification.deleteMany({ where: { userId, email: address } }),
        prisma.emailVerification.create({
            data: {
                userId,
                email: address,
                tokenHash: hashToken(token),
                expiresAt: new Date(Date.now() + LINK_TTL_MS)
            }
        })
    ]);

    const { text, html } = messageBody(await verificationUrl(token));
    const result = await sendAuthEmail({ to: address, subject: "Confirm your address", text, html });
    if (result.error) {
        // Nothing was delivered, so leave no live token behind.
        await prisma.emailVerification.deleteMany({ where: { userId, email: address } });
        return result;
    }
    return {};
}

/**
 * Spend a verification link. Returns the address it proved, or null when the
 * token is unknown, expired, or names an address that has since left the account.
 */
export async function consumeEmailVerification(token: string): Promise<VerifiedAddress | null> {
    const row = await prisma.emailVerification.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row) return null;
    // Spent either way: an expired link is not worth keeping around.
    await prisma.emailVerification.deleteMany({ where: { id: row.id } });
    if (row.expiresAt.getTime() < Date.now()) return null;

    const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { email: true } });
    if (!user) return null;

    if (user.email.toLowerCase() === row.email) {
        await prisma.user.update({ where: { id: row.userId }, data: { emailVerified: true } });
        return { email: row.email, primary: true };
    }
    const updated = await prisma.userEmail.updateMany({
        where: { userId: row.userId, email: row.email },
        data: { verifiedAt: new Date() }
    });
    // The address was removed from the account between sending and clicking.
    if (updated.count === 0) return null;
    return { email: row.email, primary: false };
}
