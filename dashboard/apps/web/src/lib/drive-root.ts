/**
 * Whether Drive reads a registered server as root for this viewer.
 *
 * Drive used to read every server as the login enrollment created, so an
 * administrator browsing the machine Polaris runs on found `/root` and every
 * other root-owned folder refused - on a server Polaris already manages as root
 * from the terminal. Root here is the same grant the terminal's root shell uses:
 * the server's enrollment gave the login password-less sudo (`Host.sudo`, what
 * the machine reported), and the viewer is somebody who manages servers.
 * Everybody else keeps the login's narrower view.
 */

import { prisma } from "@polaris/db";
import { effectiveCan, effectiveIsAdmin } from "@/lib/effective-access";

/** The decision itself, kept pure so it can be asserted without a database. */
export function browsesAsRoot(input: {
    /** The server granted the login password-less sudo. */
    readonly sudo: boolean;
    /** The viewer is an administrator right now (a previewed role is not). */
    readonly admin: boolean;
    /** The viewer holds the permission the Servers app manages servers with. */
    readonly managesServers: boolean;
}): boolean {
    return input.sudo && (input.admin || input.managesServers);
}

/** What a viewer may do on one server: root or not, and whether the server
 *  could give root at all - the screen words a refusal differently for each. */
export interface HostRootAccess {
    readonly asRoot: boolean;
    readonly sudo: boolean;
    readonly managesServers: boolean;
}

export async function hostRootAccess(userId: string, hostId: string): Promise<HostRootAccess> {
    const [user, host] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } }),
        prisma.host.findUnique({ where: { id: hostId }, select: { sudo: true } })
    ]);
    const admin = await effectiveIsAdmin(userId, user?.isAdmin === true);
    const managesServers = admin || (await effectiveCan(userId, "system.manage"));
    const sudo = host?.sudo === true;
    return { asRoot: browsesAsRoot({ sudo, admin, managesServers }), sudo, managesServers };
}

/**
 * The machine Polaris runs on is enrolled once, by whoever got there first, and
 * a Host belongs to the account that enrolled it. That is right for a server
 * somebody brought along, and wrong for this one: it is the deployment's own box,
 * and every administrator who manages servers manages it. So its Host - the one
 * the local enrollment points at - reaches anybody who manages servers, not only
 * its owner.
 */
export function reachesLocalHost(input: {
    /** The Host the local enrollment points at, or null while there is none. */
    readonly localHostId: string | null;
    readonly hostId: string;
    readonly managesServers: boolean;
}): boolean {
    return input.managesServers && input.localHostId !== null && input.localHostId === input.hostId;
}

/** Whether this viewer manages servers - an administrator, or the permission the
 *  Servers app manages them with. */
export async function managesServers(userId: string): Promise<boolean> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
    return (await effectiveIsAdmin(userId, user?.isAdmin === true)) || effectiveCan(userId, "system.manage");
}
