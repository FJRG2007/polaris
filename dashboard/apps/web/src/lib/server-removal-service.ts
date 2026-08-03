/**
 * Taking a server out of Polaris.
 *
 * Removing the row is the easy part and the least of what the operator means.
 * A machine that has been managed for a while is carrying deployed services, a
 * login Polaris created for itself, and possibly a sudo grant - and the row is
 * the only record of any of it. Deleting it quietly cascades every service on
 * that server out of the database while the containers keep running there,
 * unmanaged and unreachable, which is the worst of the three possible outcomes.
 *
 * So the operator picks one:
 *   - disconnect: forget the login. The machine keeps running exactly as it is,
 *     and what Polaris knew about it is gone. For a box that is being handed to
 *     somebody else, or that Polaris should simply stop touching.
 *   - clean: take the services down and give the login back first, so nothing is
 *     left running that nobody is managing and no key of ours stays authorized.
 *   - move: put the services on another server first, then clean. The cutover is
 *     per service and in that order - new one up and healthy, then the old one
 *     down - so a service is never off while it is being moved.
 *
 * What no mode does is move DATA. A named volume lives on the machine it was
 * created on; a service that moves gets its volume re-created empty on the far
 * side. That is stated up front (see `localVolumes`) rather than discovered
 * afterwards, because it is not something a rollback can undo.
 */

import { prisma } from "@polaris/db";
import { execCommand, openSshClient } from "@polaris/ssh";
import { deleteHost, getHostConnection } from "@/lib/host-service";
import { getOrCreateHostTarget, getOrCreateLocalTarget } from "@/lib/deploy-target-service";
import { deployAndWait, stopApplicationOnTarget, syncAppRoutes } from "@/lib/deploy-service";

/** How a server is taken out. Each one includes everything the one before it does. */
export type ServerRemovalMode = "disconnect" | "clean" | "move";

export interface RemovalService {
    readonly id: string;
    readonly name: string;
    readonly project: string;
    /** Whether it is actually running there right now, as opposed to only configured. */
    readonly deployed: boolean;
}

export interface ServerRemovalPlan {
    readonly name: string;
    readonly services: RemovalService[];
    /** Volumes whose data physically lives on this machine, so it does not move. */
    readonly localVolumes: number;
    /** CI runner pools pointed at this server; they stop having anywhere to run. */
    readonly runnerPools: number;
    /** Polaris created the login here, so it can take it back off the machine. */
    readonly enrolled: boolean;
    readonly sudo: boolean;
    /** Servers the services can move to. Empty means "move" is not offered. */
    readonly destinations: { readonly id: string; readonly name: string }[];
}

/**
 * What removing this server would affect. Read before anything is destroyed so the
 * dialog can say it in specifics ("3 services, 2 volumes stay behind") rather than
 * in the abstract.
 */
export async function getServerRemovalPlan(ownerId: string, hostId: string): Promise<ServerRemovalPlan | null> {
    const host = await prisma.host.findFirst({
        where: { id: hostId, ownerId },
        select: { id: true, name: true, sudo: true }
    });
    if (!host) return null;

    const [apps, localVolumes, runnerPools, enrollment, otherHosts] = await Promise.all([
        prisma.application.findMany({
            where: { target: { hostId, ownerId } },
            select: {
                id: true,
                name: true,
                currentDeploymentId: true,
                environment: { select: { project: { select: { name: true } } } }
            },
            orderBy: { name: "asc" }
        }),
        prisma.volume.count({ where: { target: { hostId, ownerId }, kind: { in: ["volume", "bind"] } } }),
        prisma.runnerPool.count({ where: { hostId } }),
        prisma.enrollment.findFirst({ where: { hostId }, select: { id: true } }),
        prisma.host.findMany({
            where: { ownerId, id: { not: hostId } },
            select: { id: true, name: true },
            orderBy: { name: "asc" }
        })
    ]);

    return {
        name: host.name,
        services: apps.map((app) => ({
            id: app.id,
            name: app.name,
            project: app.environment.project.name,
            deployed: app.currentDeploymentId !== null
        })),
        localVolumes,
        runnerPools,
        enrolled: enrollment !== null,
        sudo: host.sudo,
        destinations: [{ id: "local", name: "This server" }, ...otherHosts]
    };
}

export interface RemoveServerInput {
    readonly mode: ServerRemovalMode;
    /** Where the services go, for "move": a host id, or "local". */
    readonly destinationId?: string;
}

export interface RemoveServerResult {
    readonly error?: string;
    /** Services that finished the move, so a partial run can say how far it got. */
    readonly moved?: string[];
    /** What could not be undone on the machine itself, said plainly rather than
     *  swallowed: the server may be off, or the login may lack the rights. */
    readonly warnings?: string[];
}

/**
 * Take a server out. Everything that touches the machine happens before the row is
 * deleted - once it is gone, so are the credentials needed to reach it - and a
 * failure to move a service stops the whole thing with the server still connected,
 * which is the only outcome that leaves the operator somewhere they can retry from.
 */
export async function removeServer(
    ownerId: string,
    hostId: string,
    userId: string,
    input: RemoveServerInput
): Promise<RemoveServerResult> {
    const host = await prisma.host.findFirst({ where: { id: hostId, ownerId } });
    if (!host) return { error: "Server not found" };

    const warnings: string[] = [];
    let moved: string[] = [];

    if (input.mode === "move") {
        if (!input.destinationId) return { error: "Choose where the services should move to" };
        if (input.destinationId === hostId) return { error: "That is the server being removed" };
        const result = await moveServices(ownerId, hostId, userId, input.destinationId);
        moved = result.moved;
        if (result.error) return { error: result.error, moved };
    }

    if (input.mode === "move" || input.mode === "clean") {
        warnings.push(...(await tearDown(ownerId, hostId)));
        warnings.push(...(await revokeLogin(ownerId, hostId)));
    }

    await deleteHost(ownerId, hostId);
    // Deployed-app routes are generated from what is left, so a removed server's
    // hostnames stop being served instead of pointing at a machine we no longer
    // reach.
    await syncAppRoutes().catch(() => undefined);
    return { moved, warnings };
}

/**
 * Move every service off a server, one at a time, each with the new one up before
 * the old one comes down.
 *
 * The order is what makes it a cutover rather than a gap: the service is retargeted
 * and deployed while the old container is still serving, and only once the new
 * deployment reports running is the old one taken down. A service that fails to
 * deploy on the far side is put back on its original server untouched and the move
 * stops there - a half-moved estate is worth strictly less than a stopped one that
 * says which service refused.
 */
async function moveServices(
    ownerId: string,
    hostId: string,
    userId: string,
    destinationId: string
): Promise<{ moved: string[]; error?: string }> {
    const destination =
        destinationId === "local"
            ? await getOrCreateLocalTarget(ownerId)
            : await destinationHostTarget(ownerId, destinationId);
    if (!destination) return { moved: [], error: "The server to move to was not found" };

    const apps = await prisma.application.findMany({
        where: { target: { hostId, ownerId } },
        select: { id: true, name: true, targetId: true, currentDeploymentId: true },
        orderBy: { name: "asc" }
    });

    const moved: string[] = [];
    for (const app of apps) {
        const from = app.targetId;
        // Volume rows follow the service, or the plan built on the far side would
        // not find the mounts it is meant to create. Their contents do not follow -
        // that is what the dialog warns about before any of this runs.
        await prisma.$transaction([
            prisma.application.update({ where: { id: app.id }, data: { targetId: destination.id } }),
            prisma.volume.updateMany({ where: { applicationId: app.id, targetId: from }, data: { targetId: destination.id } })
        ]);

        // A service that was not running anywhere has nothing to cut over: it is
        // configured for the new server and will come up there on its next deploy.
        if (!app.currentDeploymentId) {
            moved.push(app.name);
            continue;
        }

        const failure = await deployAndWait(app.id, ownerId, userId);
        if (failure) {
            await prisma.$transaction([
                prisma.application.update({ where: { id: app.id }, data: { targetId: from } }),
                prisma.volume.updateMany({ where: { applicationId: app.id, targetId: destination.id }, data: { targetId: from } })
            ]);
            return { moved, error: `${app.name} could not be deployed on the new server: ${failure}` };
        }
        // Up and serving on the far side; the old containers are now the only thing
        // still holding the machine, so they come down.
        await stopApplicationOnTarget(app.id, ownerId, from).catch(() => undefined);
        moved.push(app.name);
    }
    return { moved };
}

/** The destination as a deploy target, or null when that server is not one of the
 *  owner's. Adopting it as a target is what a first deploy there would do anyway. */
async function destinationHostTarget(ownerId: string, hostId: string) {
    const host = await prisma.host.findFirst({ where: { id: hostId, ownerId }, select: { id: true, name: true } });
    return host ? getOrCreateHostTarget(host.id, ownerId, host.name) : null;
}

/** Take down everything Polaris is running on this server. Failures are collected
 *  rather than thrown: a machine that is already off cannot be tidied, and that is
 *  not a reason to leave it connected. */
async function tearDown(ownerId: string, hostId: string): Promise<string[]> {
    const apps = await prisma.application.findMany({
        where: { target: { hostId, ownerId }, currentDeploymentId: { not: null } },
        select: { id: true, name: true, targetId: true }
    });
    const warnings: string[] = [];
    for (const app of apps) {
        try {
            await stopApplicationOnTarget(app.id, ownerId, app.targetId);
        } catch {
            warnings.push(`${app.name} could not be stopped on the server`);
        }
    }
    return warnings;
}

/**
 * Give the machine its login back.
 *
 * Only for a login Polaris created for itself: an operator who registered a server
 * with an account of their own gets that account left strictly alone, because the
 * difference between "our dedicated user" and "the operator's own user" is the
 * difference between tidying up and locking somebody out of their machine.
 *
 * Enrolment recorded the exact authorized_keys entry, so exactly that line is what
 * is removed. The sudoers drop-in and the account itself only go where the login
 * was granted the sudo to remove them.
 */
async function revokeLogin(ownerId: string, hostId: string): Promise<string[]> {
    const [host, enrollment] = await Promise.all([
        prisma.host.findFirst({ where: { id: hostId, ownerId }, select: { username: true, sudo: true } }),
        prisma.enrollment.findFirst({
            where: { hostId },
            select: { publicKey: true },
            orderBy: { createdAt: "desc" }
        })
    ]);
    if (!host) return [];
    if (!enrollment) {
        return ["The login on this server was not created by Polaris, so it was left in place"];
    }

    const connection = await getHostConnection(hostId, ownerId).catch(() => null);
    if (!connection) return ["Polaris could not sign in to remove its login from the server"];

    const key = enrollment.publicKey.trim();
    const user = host.username;
    const warnings: string[] = [];
    let client;
    try {
        client = await openSshClient({
            host: connection.address,
            port: connection.port,
            username: connection.username,
            auth: connection.auth,
            pinnedHostKey: connection.hostKey
        });
        // Rewrite authorized_keys without our entry, matching the key body rather
        // than the whole line: it was written with restrictions in front of it, and
        // a future Polaris may write different ones.
        const dropped = await execCommand(
            client,
            `f="$HOME/.ssh/authorized_keys"; [ -f "$f" ] || exit 0; grep -vF ${shellQuote(key)} "$f" > "$f.polaris" && mv "$f.polaris" "$f"`
        );
        if (dropped.code !== 0) {
            warnings.push(`Polaris's key may still be authorized for '${user}' on the server; remove it there`);
        }

        if (!host.sudo) {
            warnings.push(`The '${user}' login itself was left on the server: removing it needs root`);
            return warnings;
        }
        await execCommand(client, `sudo rm -f /etc/sudoers.d/${shellQuote(user)}`).catch(() => undefined);
        // Last, and expected to fail on a machine that will not delete an account
        // with a live session on it - which is this one, right now.
        const removed = await execCommand(client, `sudo userdel -r ${shellQuote(user)}`).catch(() => ({ code: 1 }));
        if (removed.code !== 0) {
            warnings.push(
                `The '${user}' login is no longer authorized, but the account is still there: run "sudo userdel -r ${user}" on the server to finish`
            );
        }
    } catch {
        warnings.push("Polaris could not reach the server to remove its login; remove it there by hand");
    } finally {
        client?.end();
    }
    return warnings;
}

/** Single-quote a value for /bin/sh. Everything passed here is Polaris-generated,
 *  and quoting it keeps that true if it ever stops being. */
function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
