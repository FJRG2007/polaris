/**
 * Taking a storage connection out of Polaris.
 *
 * A NAS is not only a place somebody browses. Deployed services mount folders on
 * it, and those mounts are the difference between "the connection is gone" and
 * "the database lost its data directory" - which is why the volume rows refuse to
 * be orphaned at the database level rather than politely. So removing one asks the
 * same question the servers screen asks: is this thing being forgotten, or is its
 * content going somewhere else first.
 *
 *   - forget: Polaris stops using the device. Nothing on it is touched or deleted,
 *     and the links and file requests that pointed at it stop working. Refused
 *     while a service still mounts it, because that one is not a decision, it is
 *     an accident waiting to be found later.
 *   - move: everything is copied to another connection, the services that mount it
 *     are pointed at the copy and redeployed one at a time - each new container up
 *     before the old one goes - and only then is the connection forgotten.
 *
 * The copy is a copy, never a move: nothing is deleted from the old device by any
 * of this. If the operator wants the bytes gone from it they can wipe it knowing
 * the copy is already serving, which is the order that cannot lose data.
 */

import { prisma } from "@polaris/db";
import { PERSONAL_KIND } from "@polaris/core";
import { deployAndWait } from "@/lib/deploy-service";
import type { StorageDriver } from "@polaris/storage";
import { deleteConnection, getDriver } from "@/lib/storage-service";

export type ConnectionRemovalMode = "forget" | "move";

export interface ConnectionRemovalPlan {
    readonly name: string;
    /** Services that mount a folder on this device, and so cannot simply lose it. */
    readonly services: { readonly id: string; readonly name: string; readonly volume: string }[];
    /** Links and file requests that stop working when it goes. */
    readonly shares: number;
    readonly fileRequests: number;
    /** Other connections its content can be copied to. */
    readonly destinations: { readonly id: string; readonly name: string }[];
}

export interface RemoveConnectionResult {
    readonly error?: string;
    /** Services put back on their feet against the new connection. */
    readonly redeployed?: string[];
    readonly warnings?: string[];
}

/** What removing this connection would affect, read before anything is destroyed. */
export async function getConnectionRemovalPlan(
    ownerId: string,
    connectionId: string
): Promise<ConnectionRemovalPlan | null> {
    const connection = await prisma.storageConnection.findFirst({
        // A personal drive is not a connection anybody removes: it is where
        // somebody's files live, and it goes when the account does.
        where: { id: connectionId, ownerId, kind: { not: PERSONAL_KIND } },
        select: { id: true, name: true }
    });
    if (!connection) return null;

    const [volumes, shares, fileRequests, others] = await Promise.all([
        prisma.volume.findMany({
            where: { connectionId },
            select: { name: true, application: { select: { id: true, name: true } } }
        }),
        prisma.share.count({ where: { connectionId } }),
        prisma.fileRequest.count({ where: { destinationConnectionId: connectionId } }),
        prisma.storageConnection.findMany({
            where: { ownerId, id: { not: connectionId }, kind: { not: PERSONAL_KIND } },
            select: { id: true, name: true },
            orderBy: { name: "asc" }
        })
    ]);

    return {
        name: connection.name,
        services: volumes
            .filter((volume) => volume.application !== null)
            .map((volume) => ({
                id: volume.application!.id,
                name: volume.application!.name,
                volume: volume.name
            })),
        shares,
        fileRequests,
        destinations: others
    };
}

export interface RemoveConnectionInput {
    readonly mode: ConnectionRemovalMode;
    readonly destinationId?: string;
}

/**
 * Remove a connection the way the operator chose. Copying can take a long time -
 * it is every byte on the device, over the network - so the caller is expected to
 * be waiting on it and to say so on screen.
 */
export async function removeConnection(
    ownerId: string,
    connectionId: string,
    userId: string,
    input: RemoveConnectionInput
): Promise<RemoveConnectionResult> {
    const plan = await getConnectionRemovalPlan(ownerId, connectionId);
    if (!plan) return { error: "Connection not found" };

    if (input.mode === "forget") {
        if (plan.services.length > 0) {
            const names = plan.services.map((service) => service.name).join(", ");
            return {
                error: `${names} still ${plan.services.length === 1 ? "mounts" : "mount"} this connection. Move its content to another connection first, or remove those volumes.`
            };
        }
        await deleteConnection(ownerId, connectionId);
        return {};
    }

    if (!input.destinationId) return { error: "Choose where the content should go" };
    if (input.destinationId === connectionId) return { error: "That is the connection being removed" };
    const destination = await prisma.storageConnection.findFirst({
        where: { id: input.destinationId, ownerId, kind: { not: PERSONAL_KIND } },
        select: { id: true }
    });
    if (!destination) return { error: "The connection to copy to was not found" };

    const copied = await copyEverything(ownerId, connectionId, destination.id);
    if (copied) return { error: copied };

    // The bytes are on the far side under the same paths, so a volume only has to
    // be told which device it lives on now. Done in one statement: a half-repointed
    // set of volumes would deploy services against two different devices.
    await prisma.volume.updateMany({ where: { connectionId }, data: { connectionId: destination.id } });

    const redeployed: string[] = [];
    const warnings: string[] = [];
    for (const service of plan.services) {
        const failure = await deployAndWait(service.id, ownerId, userId);
        if (failure) {
            // The volumes already point at the copy, so putting the connection back
            // would be the wrong repair: what is wrong is this one service, and it
            // is deployable again by hand once its reason is fixed.
            warnings.push(`${service.name} did not come back up on the new connection: ${failure}`);
            continue;
        }
        redeployed.push(service.name);
    }

    await deleteConnection(ownerId, connectionId);
    return { redeployed, warnings };
}

/**
 * Copy every file from one connection to another, keeping paths identical so a
 * volume that pointed into the old one lands on the same folder in the new one.
 * Returns null on success or a message on failure - a partial copy is left in
 * place deliberately, because the alternative is deleting a half-written
 * destination that may already hold the only good copy of something.
 */
async function copyEverything(ownerId: string, fromId: string, toId: string): Promise<string | null> {
    let from: StorageDriver | undefined;
    let to: StorageDriver | undefined;
    try {
        from = await getDriver(fromId, ownerId);
        to = await getDriver(toId, ownerId);
        await copyTree(from, to, "");
        return null;
    } catch (caught) {
        return caught instanceof Error ? caught.message : "the content could not be copied";
    } finally {
        await from?.dispose().catch(() => undefined);
        await to?.dispose().catch(() => undefined);
    }
}

/** One folder, then everything under it. Streamed file by file: a NAS holds more
 *  than fits in memory, and a copy that buffers is a copy that dies on the big one. */
async function copyTree(from: StorageDriver, to: StorageDriver, path: string): Promise<void> {
    let cursor: string | undefined;
    do {
        const page = await from.list(path, cursor ? { cursor } : undefined);
        for (const entry of page.entries) {
            if (entry.kind === "dir") {
                await to.mkdir(entry.path).catch(() => undefined);
                await copyTree(from, to, entry.path);
            } else if (entry.kind === "file") {
                await to.writeStream(entry.path, await from.readStream(entry.path), {
                    size: entry.size,
                    mime: entry.mime
                });
            }
            // A symlink is a pointer into a filesystem that is being left behind;
            // copying it would produce a link to nothing on the new device.
        }
        cursor = page.nextCursor;
    } while (cursor);
}
