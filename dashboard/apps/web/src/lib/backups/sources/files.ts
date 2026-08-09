/**
 * The two file sources: a volume one of your services keeps its data in, and a
 * folder on a storage connection.
 *
 * Different mechanisms for the same shape. A volume only exists inside the
 * container that mounts it, so it is tarred in there and streamed out. A NAS
 * folder is reachable through its connection's driver, so it is zipped through
 * the same archive path Drive already uses for a folder download - one
 * implementation, so a backup of a folder and a download of it cannot disagree
 * about what "the folder" contains.
 */

import { join } from "node:path";
import { prisma } from "@polaris/db";
import { Readable } from "node:stream";
import { buildSelector } from "../schemas";
import { createWriteStream } from "node:fs";
import { LocalDriver } from "@polaris/storage";
import { pipeline } from "node:stream/promises";
import { getPorts } from "@/lib/deploy/runtime";
import { volumeRuntime } from "@/lib/deploy-volume-service";
import { getDriverForConnection } from "@/lib/storage-service";
import { writeArchiveToDriver, zipSourcesFor } from "@/lib/drive-archive";
import {
    SourceUnavailableError,
    shellQuote,
    stageDir,
    stagedFrom,
    stamp,
    type BackupSource,
    type DiscoveredTarget,
    type SourceResource,
    type StagedArtifact
} from "./types";

/** A name a filesystem and every destination will accept. */
function safeLabel(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60) || "backup";
}

/** A volume one of your services keeps its data in. */
export const deployVolumeSource: BackupSource = {
    kind: "deploy-volume",

    async discover(ownerId: string): Promise<DiscoveredTarget[]> {
        const rows = await prisma.volume.findMany({
            where: { target: { ownerId }, applicationId: { not: null } },
            select: {
                id: true,
                name: true,
                mountPath: true,
                application: { select: { name: true } }
            },
            take: 500
        });
        return rows.map((row) => ({
            kind: "deploy-volume" as const,
            selector: buildSelector("deploy-volume", [row.id]),
            name: row.name,
            context: row.application?.name ?? row.mountPath,
            target: { kind: "deploy-volume", volumeId: row.id }
        }));
    },

    async resolveName(resource: SourceResource): Promise<string | null> {
        const id = resource.selector.split(":")[1];
        if (!id) return null;
        const row = await prisma.volume.findUnique({ where: { id }, select: { name: true } });
        return row?.name ?? null;
    },

    /**
     * Tar the mount point inside the container, then stream it out.
     *
     * The archive is written to /tmp rather than piped straight through the exec
     * channel, for the same reason a database dump is: the channel collects into
     * a string. It is removed afterwards whether the read worked or not - a
     * failed backup that fills the service's own disk is worse than no backup.
     */
    async produce(resource: SourceResource): Promise<StagedArtifact> {
        const id = resource.selector.split(":")[1];
        if (!id) throw new SourceUnavailableError("This volume's id is missing from its record");

        let runtime;
        try {
            runtime = await volumeRuntime(id, resource.ownerId);
        } catch (error) {
            // "The service is not running" is the ordinary case here, and it is
            // the reason worth recording rather than a stack.
            throw new SourceUnavailableError(
                error instanceof Error ? error.message : "That volume cannot be reached right now"
            );
        }

        const at = new Date();
        const fileName = `${safeLabel(runtime.volume.name)}-${stamp(at)}.tar.gz`;
        const inContainer = `/tmp/polaris-backup-${stamp(at)}.tar.gz`;
        const ports = await getPorts(runtime.target, resource.ownerId);
        try {
            // -C into the mount and archive ".", so the tar holds the volume's
            // contents rather than the absolute path it happened to be mounted at.
            const tarred = await ports.runIn(runtime.container, [
                "sh",
                "-c",
                `tar -czf ${shellQuote(inContainer)} -C ${shellQuote(runtime.volume.mountPath)} .`
            ]);
            if (tarred.code !== 0) {
                throw new SourceUnavailableError(
                    `Archiving ${runtime.volume.mountPath} failed: ${tarred.output.trim().slice(0, 400) || `exit ${tarred.code}`}`
                );
            }
            const dir = await stageDir();
            const target = join(dir, fileName);
            const bytes = await ports.readFile(runtime.container, inContainer);
            await pipeline(
                Readable.fromWeb(bytes as import("node:stream/web").ReadableStream),
                createWriteStream(target)
            );
            return stagedFrom(dir, target, fileName, {
                mountPath: runtime.volume.mountPath,
                volumeKind: runtime.volume.kind,
                takenAt: at.toISOString()
            });
        } finally {
            await ports.runIn(runtime.container, ["rm", "-f", "--", inContainer]).catch(() => undefined);
            await ports.dispose();
        }
    },

    /**
     * Unpack an archive back over the mount point.
     *
     * Deliberately additive - `tar -x` overwrites what the archive holds and
     * leaves anything else alone - because emptying the volume first would turn
     * a restore that fails halfway into a service with no data at all.
     */
    async restore(resource: SourceResource, body: ReadableStream<Uint8Array>): Promise<void> {
        const id = resource.selector.split(":")[1];
        if (!id) throw new SourceUnavailableError("This volume's id is missing from its record");
        const runtime = await volumeRuntime(id, resource.ownerId);
        const ports = await getPorts(runtime.target, resource.ownerId);
        const inContainer = `/tmp/polaris-restore-${stamp(new Date())}.tar.gz`;
        try {
            const bytes = Buffer.from(await new Response(body).arrayBuffer());
            await writeThroughShell(ports, runtime.container, inContainer, bytes);
            const unpacked = await ports.runIn(runtime.container, [
                "sh",
                "-c",
                `tar -xzf ${shellQuote(inContainer)} -C ${shellQuote(runtime.volume.mountPath)}`
            ]);
            if (unpacked.code !== 0) {
                throw new SourceUnavailableError(
                    `Unpacking into ${runtime.volume.mountPath} failed: ${unpacked.output.trim().slice(0, 400)}`
                );
            }
        } finally {
            await ports.runIn(runtime.container, ["rm", "-f", "--", inContainer]).catch(() => undefined);
            await ports.dispose();
        }
    }
};

/** A folder on a storage connection. */
export const nasPathSource: BackupSource = {
    kind: "nas-path",

    async discover(): Promise<DiscoveredTarget[]> {
        // A connection holds any number of folders and Polaris has no way to
        // guess which one matters; somebody picks it.
        return [];
    },

    async resolveName(resource: SourceResource): Promise<string | null> {
        return resource.name;
    },

    /**
     * Zip the folder through its connection's driver.
     *
     * The archive is built by the same code Drive's folder download uses, and
     * written through a LocalDriver pointed at the staging directory - so the
     * zip walks and streams exactly as it does there, and lands as a local file
     * the engine can replicate from.
     */
    async produce(resource: SourceResource): Promise<StagedArtifact> {
        const [, connectionId, ...rest] = resource.selector.split(":");
        const path = rest.join(":");
        if (!connectionId) throw new SourceUnavailableError("This folder's connection is missing from its record");

        const driver = await getDriverForConnection(connectionId).catch((error: unknown) => {
            throw new SourceUnavailableError(
                error instanceof Error ? error.message : "That storage connection cannot be reached"
            );
        });
        const at = new Date();
        const fileName = `${safeLabel(resource.name)}-${stamp(at)}.zip`;
        const dir = await stageDir();
        try {
            const staging = new LocalDriver({ id: `stage-${resource.id}`, root: dir });
            await writeArchiveToDriver(staging, fileName, zipSourcesFor(driver, [path], new Set()));
            return stagedFrom(dir, join(dir, fileName), fileName, {
                connectionId,
                path,
                takenAt: at.toISOString()
            });
        } finally {
            await driver.dispose();
        }
    }
    // No restore: putting a folder back means writing over whatever is there
    // now, and a folder somebody has since reorganised is not a thing to
    // overwrite because a schedule said so. The console offers the download.
};

/**
 * Push bytes into a container through its shell, base64 encoded.
 *
 * The exec channel carries a command line rather than a body, so raw bytes would
 * be mangled by the first one that is not valid UTF-8, and a command line has a
 * length limit an archive passes immediately - hence the chunking.
 */
async function writeThroughShell(
    ports: { runIn(container: string, argv: readonly string[]): Promise<{ code: number; output: string }> },
    container: string,
    path: string,
    bytes: Buffer
): Promise<void> {
    const CHUNK = 32 * 1024;
    const encoded = bytes.toString("base64");
    const staged = `${path}.b64`;
    const refuse = (result: { code: number; output: string }, what: string): void => {
        if (result.code !== 0) {
            throw new SourceUnavailableError(`${what}: ${result.output.trim().slice(0, 300) || `exit ${result.code}`}`);
        }
    };
    refuse(await ports.runIn(container, ["sh", "-c", `: > ${shellQuote(staged)}`]), "Could not stage the archive");
    for (let at = 0; at < encoded.length; at += CHUNK) {
        refuse(
            await ports.runIn(container, [
                "sh",
                "-c",
                `printf %s ${shellQuote(encoded.slice(at, at + CHUNK))} >> ${shellQuote(staged)}`
            ]),
            "Could not stage the archive"
        );
    }
    refuse(
        await ports.runIn(container, [
            "sh",
            "-c",
            `base64 -d ${shellQuote(staged)} > ${shellQuote(path)} && rm -f ${shellQuote(staged)}`
        ]),
        "Could not decode the staged archive"
    );
}
