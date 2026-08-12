/**
 * The passkeys on an account, as every surface that lists one describes them:
 * the security page's table, and the panel for a single device.
 *
 * One reader for both, because the facts a passkey is recognised by are derived
 * rather than stored - a credential registered before Polaris followed the
 * address is bound to the published one, one registered before it recorded the
 * browser belongs to no device, and the browser and system it names are read out
 * of what that browser claimed - and a second copy of those rules would
 * eventually disagree with this one about what the same row is.
 *
 * Never returns the credential itself. A passkey's public key and counter are
 * the authenticator's business; nothing on a screen needs them.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { describeClient, passkeyRelyingPartyId } from "@polaris/core";

export interface PasskeyView {
    id: string;
    name: string;
    /** The address it signs in on. WebAuthn binds a credential to exactly one. */
    host: string;
    /** The browser that registered it, and the system that browser was on.
     *  "Unknown browser" and "Unknown OS" on a row registered before Polaris
     *  recorded any of it. */
    browser: string;
    os: string;
    /** Where the registration came from. Null on rows that predate the column. */
    ip: string | null;
    /** ISO timestamps; the caller renders them in the reader's locale. */
    addedAt: string;
    /** When it last proved a sign-in, or null if it never has. */
    lastUsedAt: string | null;
}

/**
 * A user's passkeys, oldest first.
 *
 * `userAgent` narrows them to the ones a single browser registered, which is
 * what the device panel needs - matched exactly, because a browser reports
 * itself the same way every time and anything looser would attach one device's
 * credentials to another. Rows from before the browser was recorded carry none
 * and so belong to no device, which is the honest answer rather than a guess.
 */
export async function listUserPasskeys(userId: string, userAgent?: string): Promise<PasskeyView[]> {
    const rows = await prisma.passkey.findMany({
        where: { userId, ...(userAgent ? { userAgent } : {}) },
        orderBy: { createdAt: "asc" },
        select: {
            id: true,
            name: true,
            rpId: true,
            ip: true,
            userAgent: true,
            userAgentBrands: true,
            userAgentPlatform: true,
            createdAt: true,
            lastUsedAt: true
        }
    });
    // Rows from before passkeys followed the address carry none: every one of
    // them was issued under the published app URL.
    const published = passkeyRelyingPartyId(loadEnv().POLARIS_APP_URL) ?? "";
    return rows.map((row) => {
        const client = describeClient(row.userAgent, row.userAgentBrands, row.userAgentPlatform);
        return {
            id: row.id,
            name: row.name?.trim() || "Unnamed passkey",
            host: row.rpId ?? published,
            browser: client.browser,
            os: client.os,
            ip: row.ip,
            addedAt: row.createdAt.toISOString(),
            lastUsedAt: row.lastUsedAt?.toISOString() ?? null
        };
    });
}
