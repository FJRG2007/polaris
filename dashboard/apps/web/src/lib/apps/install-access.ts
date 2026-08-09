/**
 * Who may reach one installed app, and whose shelf it sits on.
 *
 * A thin layer over resource-access that adds the two things game code needs and
 * the general resolver cannot know: that the install is actually a game server,
 * and the install row itself, which every caller wanted anyway.
 *
 * The refusal it raises is the same for "no such server" and "not yours". Which of
 * the two it was is not something somebody who cannot see it is owed.
 */

import * as core from "@polaris/core";
import { grantsForUser } from "@polaris/auth";
import { isGameServerApp } from "@/lib/apps/games-service";
import { requireUser, type SessionUser } from "@/lib/session";
import { getInstalledApp, type InstalledAppDetail } from "@/lib/apps/install-service";
import { heldOn, reachableResources, resourceAccess, type ResourceAccess } from "@/lib/resource-access";

/** The reference an installed app is addressed by. */
export function installRef(installedAppId: string): core.ResourceRef {
    return core.resourceRef("install", installedAppId);
}

export interface GameServerAccess extends ResourceAccess {
    /** The install, already read on the owner's behalf. */
    readonly install: InstalledAppDetail;
}

/** This user's standing on one game server, or null when they have none. */
export async function gameServerAccess(
    user: SessionUser,
    installedAppId: string,
    permission: core.Permission
): Promise<GameServerAccess | null> {
    const access = await resourceAccess(user, installRef(installedAppId), permission);
    if (!access) return null;
    const install = await getInstalledApp(access.ownerId, installedAppId);
    // The games grants are about game servers, so they may not be spent on an
    // arbitrary install: without this a games.manage holder could stop or delete
    // the messaging bridge by passing its id to a game action.
    if (!install || !isGameServerApp(install.catalogId)) return null;
    return { ...access, install };
}

/**
 * The session and the standing on one game server, for a server action.
 *
 * Two ids come back and they are not the same. `access.ownerId` is whose shelf the
 * work runs on and belongs in every call reaching a container or an owner-scoped
 * query; `user.id` is who is doing it and belongs in every audit entry.
 */
export async function requireGameServer(
    permission: core.Permission,
    installedAppId: string
): Promise<{ user: SessionUser; access: GameServerAccess }> {
    const user = await requireUser();
    const access = await gameServerAccess(user, installedAppId, permission);
    if (!access) throw new Error("Server not found");
    return { user, access };
}

/** The same, for the handful of actions that only the server's owner should
 *  reach. Deleting a server is not something a grant hands out: "manage" is the
 *  console, the worlds and the settings, not the power to take the whole thing off
 *  somebody. */
export async function requireGameServerOwner(
    installedAppId: string
): Promise<{ user: SessionUser; access: GameServerAccess }> {
    const resolved = await requireGameServer("games.manage", installedAppId);
    if (!resolved.access.isOwner && !resolved.user.isAdmin) {
        throw new Error("Only the person who created this server can do that");
    }
    return resolved;
}

/** What this user may do on one game server, for a screen deciding which controls
 *  to draw. Only the games grants: the deploy ones belong to the install's own
 *  lifecycle, which the game screens do not offer. */
export async function gamePermissionsFor(user: SessionUser, installedAppId: string): Promise<core.Permission[]> {
    return heldOn(user, installRef(installedAppId), ["games.read", "games.moderate", "games.manage"]);
}

/** Ids of the installs this user reaches beyond the ones they own. */
export async function reachableInstallIds(user: SessionUser, permission: core.Permission): Promise<string[]> {
    return reachableResources(user, "install", permission);
}

/**
 * Whether this person may pass their access to one thing on, and how far.
 *
 * The owner always may. Anybody else may only if a grant said so, and only up to
 * their own end date: a helper cannot outlive the person who invited them, or
 * revoking the inviter would leave whoever they brought in still holding the keys.
 */
export async function sharingRightsFor(
    user: SessionUser,
    installedAppId: string,
    ownerId: string
): Promise<{ mayPassOn: boolean; until: Date | null }> {
    if (user.isAdmin || ownerId === user.id) return { mayPassOn: true, until: null };
    // A previewed role holds no grants, so it passes nothing on.
    if (user.viewingAs?.mode === "role") return { mayPassOn: false, until: null };
    const mine = (await grantsForUser(user.id)).filter(
        (grant) => grant.kind === "install" && grant.effect === "allow" && grant.canShare
    );
    const reaching = mine.filter(
        (grant) => grant.resourceId === installedAppId || grant.resourceId === core.EVERY_RESOURCE
    );
    if (reaching.length === 0) return { mayPassOn: false, until: null };
    // The longest of their own, since any one of them is enough to be here.
    const ends = reaching.map((grant) => grant.expiresAt);
    if (ends.some((end) => end === null)) return { mayPassOn: true, until: null };
    const furthest = ends.reduce<Date | null>(
        (latest, end) => (end && (!latest || end > latest) ? end : latest),
        null
    );
    return { mayPassOn: true, until: furthest };
}
