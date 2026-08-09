/**
 * Minecraft worlds.
 *
 * The only kind whose copies can live beside the source. A server's container
 * can tar its own world in seconds with saving held, which is worth keeping as
 * the fast copy - it covers a mistake immediately and costs the disk the server
 * already has. What it does not cover is that disk dying, which is exactly why
 * the same archive is also read out and replicated to the plan's other
 * destinations.
 *
 * Nothing here re-implements the archiving: `world-service` already knows how to
 * hold the save, tar the right folders per edition, prune, and restore beside
 * the live level rather than over it. This wraps that so the engine sees the
 * same interface it sees for a database, and so the World screen and the backup
 * console cannot end up disagreeing about what is on disk.
 *
 * Every operation needs the server running, because `docker exec` does. Callers
 * are told that plainly rather than being handed a blank failure.
 */

import { join } from "node:path";
import { prisma } from "@polaris/db";
import { Readable } from "node:stream";
import { buildSelector } from "../schemas";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { listGameServerFacts } from "@/lib/apps/games-service";
import { withServerContainer } from "@/lib/apps/minecraft/service";
import {
    backupPathInContainer,
    createWorldBackup,
    deleteWorldBackup,
    readWorldView,
    restoreWorldBackup
} from "@/lib/apps/minecraft/world-service";
import {
    SourceUnavailableError,
    shellQuote,
    stageDir,
    stagedFrom,
    type BackupSource,
    type DiscoveredTarget,
    type InPlaceCopy,
    type SourceResource,
    type StagedArtifact
} from "./types";

/** The install a resource names. */
function installIdOf(resource: SourceResource): string {
    const id = resource.selector.split(":")[1];
    if (!id) throw new SourceUnavailableError("This world's server is missing from its record");
    return id;
}

export const minecraftWorldSource: BackupSource = {
    kind: "minecraft-world",

    async discover(ownerId: string): Promise<DiscoveredTarget[]> {
        const servers = await listGameServerFacts(ownerId).catch(() => []);
        return servers.map((server) => ({
            kind: "minecraft-world" as const,
            selector: buildSelector("minecraft-world", [server.id]),
            name: server.name,
            context: "Game server",
            target: { kind: "minecraft-world", installedAppId: server.id }
        }));
    },

    async resolveName(resource: SourceResource): Promise<string | null> {
        const row = await prisma.installedApp.findUnique({
            where: { id: installIdOf(resource) },
            select: { name: true, status: true }
        });
        // A removed server is not renamed, it is gone - the engine marks the
        // resource missing on a null, and its copies stay restorable.
        if (!row || row.status === "removed") return null;
        return row.name;
    },

    /**
     * Take the archive beside the world.
     *
     * This is the copy the plan's beside-the-source destination holds, and it is
     * also what `produce` reads out - so a backup is one archive that lands in
     * several places, not one per destination taken minutes apart from a world
     * that changed in between.
     */
    async produceInPlace(resource: SourceResource): Promise<InPlaceCopy> {
        const installedAppId = installIdOf(resource);
        const taken = await createWorldBackup(resource.ownerId, installedAppId).catch((error: unknown) => {
            throw new SourceUnavailableError(
                error instanceof Error ? error.message : "The server could not be asked to back up"
            );
        });
        return {
            path: taken.name,
            sizeBytes: taken.sizeBytes,
            takenAt: new Date(taken.createdAt)
        };
    },

    async readInPlace(resource: SourceResource, path: string): Promise<ReadableStream<Uint8Array>> {
        const installedAppId = installIdOf(resource);
        return withServerContainer(resource.ownerId, installedAppId, (server) =>
            server.readFile(backupPathInContainer(path))
        );
    },

    async removeInPlace(resource: SourceResource, path: string): Promise<void> {
        await deleteWorldBackup(resource.ownerId, installIdOf(resource), path);
    },

    /**
     * Stage the archive for the destinations that are not the server's own disk.
     *
     * It takes one in place first and reads that out, rather than tarring
     * straight into a stream. Two reasons: the size has to be known before it can
     * be uploaded anywhere (OneDrive refuses a large upload without a total), and
     * the archive that goes to S3 is then byte-for-byte the one sitting on the
     * server, which is what makes "the same backup, in three places" true rather
     * than approximately true.
     */
    async produce(resource: SourceResource): Promise<StagedArtifact> {
        const installedAppId = installIdOf(resource);
        const view = await readWorldView(resource.ownerId, installedAppId).catch(() => null);
        const taken = await this.produceInPlace!(resource);
        if (!taken) throw new SourceUnavailableError("The server produced no archive");

        const dir = await stageDir();
        const target = join(dir, taken.path);
        const bytes = await this.readInPlace!(resource, taken.path);
        await pipeline(
            Readable.fromWeb(bytes as import("node:stream/web").ReadableStream),
            createWriteStream(target)
        );
        return stagedFrom(dir, target, taken.path, {
            edition: view?.edition ?? null,
            // The level is what a restore has to put back, and the server may be
            // playing a different one by then.
            level: view?.level ?? null,
            takenAt: taken.takenAt.toISOString()
        });
    },

    /**
     * Put an archive back.
     *
     * The archive has to be inside the container for the server to unpack it, so
     * a copy fetched from a destination is written back in first. `world-service`
     * then unpacks it as a NEW level beside the one being played - the running
     * server is untouched until somebody switches to it, and the map it was on is
     * still there afterwards, which is what makes restoring the wrong backup
     * survivable.
     */
    async restore(
        resource: SourceResource,
        body: ReadableStream<Uint8Array>,
        metadata: Record<string, unknown>,
        actorId: string
    ): Promise<void> {
        const installedAppId = installIdOf(resource);
        const name = typeof metadata.fileName === "string" ? metadata.fileName : "";
        if (!name) throw new SourceUnavailableError("That copy has no archive name to restore from");

        await withServerContainer(resource.ownerId, installedAppId, async (server) => {
            const path = backupPathInContainer(name);
            const existing = await server.run(["test", "-f", path]);
            if (existing.code !== 0) {
                // Not on the server any more: push the copy back before asking it
                // to unpack. Buffered because the daemon's write takes a body, and
                // an archive being restored is one somebody is waiting on anyway.
                const bytes = Buffer.from(await new Response(body).arrayBuffer());
                await server.runOk(["mkdir", "-p", "--", path.slice(0, path.lastIndexOf("/"))], "Could not create the backup folder");
                await writeIntoContainer(server, path, bytes);
            }
        });
        await restoreWorldBackup(resource.ownerId, installedAppId, name, actorId);
    }
};

/**
 * Write bytes into the container through its own shell.
 *
 * base64 rather than raw: the exec channel carries a command line, not a body,
 * and an archive put through it unencoded would be mangled by the first byte
 * that is not valid UTF-8. It is chunked because a command line has a length
 * limit that a world archive passes immediately.
 */
async function writeIntoContainer(
    server: { runOk(argv: readonly string[], failure: string): Promise<string> },
    path: string,
    bytes: Buffer
): Promise<void> {
    const CHUNK = 32 * 1024;
    const encoded = bytes.toString("base64");
    await server.runOk(["sh", "-c", `: > ${shellQuote(path)}.b64`], "Could not stage the archive");
    for (let at = 0; at < encoded.length; at += CHUNK) {
        const piece = encoded.slice(at, at + CHUNK);
        await server.runOk(
            ["sh", "-c", `printf %s ${shellQuote(piece)} >> ${shellQuote(path)}.b64`],
            "Could not stage the archive"
        );
    }
    await server.runOk(
        ["sh", "-c", `base64 -d ${shellQuote(path)}.b64 > ${shellQuote(path)} && rm -f ${shellQuote(path)}.b64`],
        "Could not unpack the staged archive"
    );
}
