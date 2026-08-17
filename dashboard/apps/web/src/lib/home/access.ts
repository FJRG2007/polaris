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
import { redirect } from "next/navigation";
import type { Permission } from "@polaris/core";
import { homePathForUser, requirePermission, sessionCanAny, type SessionUser } from "@/lib/session";

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

/**
 * The same, for a screen, plus what to draw.
 *
 * A screen needs more than "may they be here": it decides whether to draw a
 * button at all, and drawing one that the action behind it will refuse is worse
 * than leaving it out. So the two wider grants come back with the session.
 *
 * Somebody who reaches /house before anybody has installed Home is not shown an
 * empty room - they are sent to the marketplace, where installing it is the
 * thing to do. Sent to their own landing page instead if they could not install
 * it anyway, since the marketplace would only refuse them next.
 */
export async function requireHomeUser(permission: Permission): Promise<{
    user: SessionUser;
    install: HomeInstall;
    canControl: boolean;
    canManage: boolean;
}> {
    const user = await requirePermission(permission);
    const install = await homeInstall();
    if (!install) redirect(user.isAdmin ? "/apps/marketplace?app=home" : await homePathForUser(user));
    const [canControl, canManage] = await Promise.all([
        sessionCanAny(user, "home.control"),
        sessionCanAny(user, "home.manage")
    ]);
    return { user, install, canControl, canManage };
}
