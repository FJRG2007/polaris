/**
 * What the extension asks with the token it was given: who it is connected as,
 * and what that connection reaches.
 *
 * Also the one call that makes revocation real. The extension asks this when it
 * wakes and on a timer, so a connection ended from the Sessions screen stops
 * that browser within minutes rather than whenever it next happened to sync -
 * and the answer is a plain 401, which is what tells the extension to drop
 * everything it holds for this server.
 *
 * `DELETE` is the extension disconnecting itself. It needs no session and proves
 * itself with the token it holds, which is the only credential it has.
 */

import { prisma } from "@polaris/db";
import { userHasPermission } from "@polaris/auth";
import { clientHost, clientIp, clientUserAgent } from "@/lib/request-context";
import { readExtensionToken, revokeExtensionToken } from "@/lib/extension/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The bearer token on a request, or null. */
function bearer(request: Request): string | null {
    const header = request.headers.get("authorization");
    if (!header) return null;
    const [scheme, value] = header.split(" ");
    if (!scheme || scheme.toLowerCase() !== "bearer" || !value) return null;
    return value.trim() || null;
}

const gone = () => Response.json({ error: "connection-ended" }, { status: 401 });

export async function GET(request: Request): Promise<Response> {
    const principal = await readExtensionToken(bearer(request), {
        ip: (await clientIp()) ?? null,
        userAgent: (await clientUserAgent()) ?? null,
        host: (await clientHost()) ?? null
    });
    if (!principal) return gone();

    const account = await prisma.user.findUnique({
        where: { id: principal.userId },
        select: { id: true, name: true, email: true }
    });
    if (!account) return gone();

    // What this account may do, so the extension offers a vault only where there
    // is one to offer rather than leading somebody to a refusal.
    const vault = await userHasPermission(principal.userId, "vault.use");
    return Response.json({
        connection: { id: principal.id, name: principal.name },
        account: { id: account.id, name: account.name ?? "", email: account.email },
        can: { vault }
    });
}

export async function DELETE(request: Request): Promise<Response> {
    const token = bearer(request);
    if (!token) return gone();
    await revokeExtensionToken(token);
    // Ended either way: a token nothing recognises is a connection that is
    // already over, and saying so differently would be a way to test tokens.
    return Response.json({ ok: true });
}
