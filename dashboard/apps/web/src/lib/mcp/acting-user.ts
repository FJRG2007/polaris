/**
 * The person an MCP call acts for, in the shape the rest of Polaris asks about.
 *
 * Every access rule an app already has - who reaches a calendar, who may
 * operate a door, who may stop a server - is written against a signed-in
 * user, because that is what its screens have. A tool call has no cookie, only
 * the account its credential belongs to, so this builds that user from the
 * account: the same id, address, name and administrator flag a session would
 * carry, and never anybody's view-as. The rules then decide exactly as they do
 * for the person's own screens, rather than a tool keeping a weaker copy.
 *
 * Null for an account that is gone, banned, switched off or on its way out:
 * nothing should be done in its name.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import type { SessionUser } from "@/lib/session";

export async function actingUser(userId: string): Promise<SessionUser | null> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            email: true,
            name: true,
            isAdmin: true,
            bannedAt: true,
            disabledAt: true,
            deletionRequestedAt: true
        }
    });
    if (!user || user.bannedAt || user.disabledAt || user.deletionRequestedAt) return null;
    // No session: a call made with a credential is not one, and nothing that
    // reads this id (signing out "this device", say) has anything to act on.
    return {
        id: user.id,
        email: user.email,
        name: user.name ?? "",
        isAdmin: user.isAdmin,
        sessionId: ""
    };
}
