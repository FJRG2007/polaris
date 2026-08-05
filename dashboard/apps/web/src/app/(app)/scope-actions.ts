"use server";

/**
 * Switching shelves.
 *
 * One write, and it is a cookie. The value is validated against the account's
 * own memberships before it is stored, so a hand-made request cannot park a
 * browser on an organization it has no part in - and even if it could, every read
 * re-checks the membership before it lists anything.
 *
 * Every path is revalidated afterwards because the shelf changes what nearly
 * every screen shows: the projects in Deploy, the spaces in Tasks, the domains on
 * an account page. A partial revalidation would leave one of them showing the
 * shelf that was open a moment ago, which is precisely the confusion the switch
 * exists to prevent.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { SCOPE_COOKIE, SCOPE_COOKIE_MAX_AGE } from "@/lib/workspace-scope";

export async function setWorkspaceScopeAction(value: string): Promise<{ error?: string }> {
    const user = await requireUser();
    const scope = core.parseScope(value);
    const orgId = core.scopeOrgId(scope);

    if (orgId) {
        const member = await prisma.organization.findFirst({
            where: { id: orgId, OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }] },
            select: { id: true }
        });
        if (!member) return { error: "You are not part of that organization" };
    }

    (await cookies()).set(SCOPE_COOKIE, core.formatScope(scope), {
        path: "/",
        maxAge: SCOPE_COOKIE_MAX_AGE,
        sameSite: "lax",
        // Readable by the switcher so it can draw itself without a round trip.
        // It names an id, not a secret, and grants nothing on its own.
        httpOnly: false
    });

    revalidatePath("/", "layout");
    return {};
}
