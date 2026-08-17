/**
 * Who may look at the house, and whether there is one yet.
 *
 * Home is one install per Polaris rather than one per person: there is a single
 * house, and everybody who lives in it is looking at the same cameras. That is
 * the whole reason this is not modelled on the game servers, where every owner
 * runs their own.
 *
 * The install carries the owner whose storage and servers the cameras run on, so
 * every camera call needs it, not just the ones that check a permission.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import type { Permission } from "@polaris/core";
import { requirePermission, type SessionUser } from "@/lib/session";

export interface HomeInstall {
    readonly id: string;
    /** Whose shelf the relay, the storage and the servers belong to. */
    readonly ownerId: string;
    readonly name: string;
}

/** The house, or null when nobody has set one up. */
export async function homeInstall(): Promise<HomeInstall | null> {
    const row = await prisma.installedApp.findFirst({
        where: { catalogId: "home", status: { not: "removed" } },
        orderBy: { createdAt: "asc" },
        select: { id: true, ownerId: true, name: true }
    });
    return row ?? null;
}

/**
 * The house, refusing rather than answering when there is none.
 *
 * For everything below the screens: an action that edits a camera has no useful
 * behavior without an install, and returning null would make every caller invent
 * its own message for a state the screen above it has already handled.
 */
export async function requireHomeInstall(): Promise<HomeInstall> {
    const install = await homeInstall();
    if (!install) throw new Error("Home is not set up yet");
    return install;
}

/**
 * The session and the house together, for a screen or an action.
 *
 * Two things come back and they are not the same: `user` is who is doing this
 * and belongs in anything recorded, `install.ownerId` is whose machines and
 * storage the work happens on.
 */
export async function requireHome(
    permission: Permission
): Promise<{ user: SessionUser; install: HomeInstall }> {
    const user = await requirePermission(permission);
    return { user, install: await requireHomeInstall() };
}
