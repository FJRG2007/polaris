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
import { scopeChoices } from "@/lib/workspace-scope";
import { bearerToken, readExtensionToken, revokeExtensionToken } from "@/lib/extension/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const gone = () => Response.json({ error: "connection-ended" }, { status: 401 });

export async function GET(request: Request): Promise<Response> {
    const principal = await readExtensionToken(bearerToken(request), {
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

    // The organizations it may switch between, as the header switcher in the
    // dashboard offers them - with the vault each one holds, so the extension can
    // narrow its list to one organization's logins the way the dashboard's shelf
    // narrows the vault screen. At most one vault per organization.
    const organizations = await scopeChoices(principal.userId);
    const vaults = organizations.length
        ? await prisma.vaultOrganization.findMany({
              where: { organizationId: { in: organizations.map((org) => org.id) } },
              select: { id: true, organizationId: true }
          })
        : [];
    return Response.json({
        connection: { id: principal.id, name: principal.name },
        account: { id: account.id, name: account.name ?? "", email: account.email },
        organizations: organizations.map((org) => ({
            id: org.id,
            name: org.name,
            slug: org.slug,
            vaultId: vaults.find((one) => one.organizationId === org.id)?.id ?? null
        })),
        can: { vault }
    });
}

export async function DELETE(request: Request): Promise<Response> {
    const token = bearerToken(request);
    if (!token) return gone();
    await revokeExtensionToken(token);
    // Ended either way: a token nothing recognises is a connection that is
    // already over, and saying so differently would be a way to test tokens.
    return Response.json({ ok: true });
}
