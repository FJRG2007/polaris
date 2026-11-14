/**
 * The session a bearer credential stands for, so what an app does is written to
 * the activity log against its own row on the sessions screen - the way a
 * browser's actions are written against its cookie session.
 *
 * Two credentials are sessions of their own: a device app's sign-in (an API key
 * of a kind in `./kinds`, whose id is the session's) and a browser extension's
 * connection. A key somebody made by hand is not a session, and is not named.
 *
 * Read-only: it never touches the credential's usage stamps, which the request's
 * own authentication already wrote.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { verifyApiKey } from "@polaris/auth";
import { hashToken } from "@polaris/core/tokens";
import { isDeviceSessionKind } from "@/lib/device-sessions/kinds";

function bearer(header: string | null): string | null {
    const [scheme, ...rest] = (header ?? "").trim().split(/\s+/);
    if (scheme?.toLowerCase() !== "bearer") return null;
    const token = rest.join("");
    return token.length > 0 ? token : null;
}

/** The session id behind an `Authorization` header, or undefined for none. */
export async function credentialSessionId(header: string | null): Promise<string | undefined> {
    const token = bearer(header);
    if (!token) return undefined;
    const key = await verifyApiKey(token);
    if (key) return isDeviceSessionKind(key.kind) ? key.id : undefined;
    const connection = await prisma.extensionSession.findUnique({
        where: { tokenHash: hashToken(token) },
        select: { id: true, revokedAt: true }
    });
    return connection && !connection.revokedAt ? connection.id : undefined;
}
