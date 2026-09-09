/**
 * Whether the Tools app is here, and whether this person may open it.
 *
 * Tools is a marketplace app: it does not exist until somebody installs it, and
 * removing it takes nothing with it, because nothing about it is wired into
 * Polaris. That is the whole point of installing it - a Polaris where nobody
 * converts a file carries no menu entry for converting files, downloads no
 * codec, and runs no worker.
 *
 * So every screen and every action under `/tools` asks here first, and the same
 * two questions are asked in the same order everywhere: is it installed, and may
 * you use it.
 */

import { prisma } from "@polaris/db";
import { redirect } from "next/navigation";
import { homePathForUser, requireUser, sessionCanAny, type SessionUser } from "@/lib/session";

/** The catalog id. One string, because it is written in the manifest, in the
 *  navigation entry and here, and a typo in any of them is an app that installs
 *  and never appears. */
export const TOOLS_APP = "tools";

export interface ToolsInstall {
    readonly id: string;
    readonly ownerId: string;
    readonly name: string;
}

/** The install, or null where there is none. A singleton in the catalog, so the
 *  oldest row wins if two ever exist. */
export async function toolsInstall(): Promise<ToolsInstall | null> {
    const row = await prisma.installedApp.findFirst({
        where: { catalogId: TOOLS_APP, status: { not: "removed" } },
        orderBy: { createdAt: "asc" },
        select: { id: true, ownerId: true, name: true }
    });
    return row ?? null;
}

/** Thrown by an action asked to work with no install behind it. */
export class ToolsError extends Error {}

/**
 * The install, refusing rather than answering when there is none.
 *
 * For the actions below the screens: converting a file has no useful behaviour
 * without an install, and answering null would have every caller invent its own
 * sentence for a state the screen above it already handles.
 */
export async function requireToolsInstall(): Promise<ToolsInstall> {
    const install = await toolsInstall();
    if (!install) throw new ToolsError("Tools is not installed");
    return install;
}

/**
 * A screen under `/tools`, with the person who opened it.
 *
 * An administrator who lands here with nothing installed is sent to the app in
 * the marketplace, which is the screen that can fix it; anybody else is sent
 * where they belong, because "install this" is not an instruction they can act
 * on.
 */
export async function requireToolsReach(): Promise<{
    user: SessionUser;
    install: ToolsInstall;
    canManage: boolean;
}> {
    const user = await requireUser();
    if (!(await sessionCanAny(user, "tools.use")))
        redirect(`${await homePathForUser(user)}?denied=1`);
    const install = await toolsInstall();
    if (!install)
        redirect(user.isAdmin ? `/apps/marketplace?app=${TOOLS_APP}` : await homePathForUser(user));
    return { user, install, canManage: await sessionCanAny(user, "tools.manage") };
}
