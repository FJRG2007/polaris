/**
 * Turning a destination row into somewhere bytes can actually be written.
 *
 * Four kinds, one interface. `local` is the data dir Polaris already owns.
 * `connection` is any storage connection, so a NAS, a bucket and a linked
 * Dropbox all arrive here as the same call with a different driver behind it.
 * `host` is a machine already enrolled, reached over the SSH credentials Polaris
 * holds - which is why connecting a server as a backup destination asks nobody
 * for a second set of credentials.
 *
 * `source-local` has no handle at all, on purpose. Those copies live inside the
 * thing being backed up - a game server's own container - and only that source
 * can write or remove one. Opening it here would mean inventing a path into a
 * container from a module that knows nothing about containers, so instead this
 * says plainly that it is not openable and the engine routes those to the source.
 */

import { Readable } from "node:stream";
import { dirname, join } from "node:path";
import { loadEnv } from "@polaris/config";
import { SftpDriver } from "@polaris/storage";
import { pipeline } from "node:stream/promises";
import { mkdir, rm, stat } from "node:fs/promises";
import { getHostConnection } from "@/lib/host-service";
import { createReadStream, createWriteStream } from "node:fs";
import { getDriverForConnection } from "@/lib/storage-service";
import { joinUnderRoot, normalizeRelPath } from "@polaris/core";

/** The row this needs, whoever loaded it. */
export interface DestinationRow {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly connectionId: string | null;
    readonly hostId: string | null;
    readonly basePath: string;
}

/** Somewhere copies can be written, read back and removed. */
export interface DestinationHandle {
    /** Write a copy and report what landed. */
    put(path: string, body: ReadableStream<Uint8Array>, size: bigint): Promise<{ sizeBytes: number }>;
    get(path: string): Promise<ReadableStream<Uint8Array>>;
    remove(path: string): Promise<void>;
    /** Bytes in use and available, when the backend can say. */
    usage(): Promise<{ used?: bigint; total?: bigint; free?: bigint }>;
    dispose(): Promise<void>;
}

/** Raised when a destination cannot be opened at all, with a reason to show. */
export class DestinationUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "DestinationUnavailableError";
    }
}

/** Whether copies for this destination are written by the source itself. */
export function isSourceLocal(destination: DestinationRow): boolean {
    return destination.kind === "source-local";
}

/**
 * Open a destination for writing.
 *
 * The caller disposes it. Sessions here are real - an SFTP connection, a pooled
 * SMB session - and a backup that leaves one open per copy exhausts the server
 * it is backing up to before it exhausts the disk.
 */
export async function openDestination(
    destination: DestinationRow,
    ownerId: string
): Promise<DestinationHandle> {
    switch (destination.kind) {
        case "local":
            return openLocal(destination);
        case "connection":
            return openConnection(destination);
        case "host":
            return openHost(destination, ownerId);
        case "source-local":
            throw new DestinationUnavailableError(
                "Copies beside the source are written by the source itself, not through a destination"
            );
        default:
            throw new DestinationUnavailableError(`Unknown destination kind: ${destination.kind}`);
    }
}

/** The data dir Polaris already owns. */
function openLocal(destination: DestinationRow): DestinationHandle {
    const root = join(loadEnv().POLARIS_DATA_DIR, normalizeRelPath(destination.basePath || "backups"));
    const resolve = (path: string) => joinUnderRoot(root, path);
    return {
        put: async (path, body, _size) => {
            const target = resolve(path);
            await mkdir(dirname(target), { recursive: true });
            await pipeline(Readable.fromWeb(body as import("node:stream/web").ReadableStream), createWriteStream(target));
            return { sizeBytes: (await stat(target)).size };
        },
        get: async (path) =>
            Readable.toWeb(createReadStream(resolve(path))) as ReadableStream<Uint8Array>,
        remove: async (path) => {
            await rm(resolve(path), { force: true });
        },
        usage: async () => {
            try {
                const { statfs } = await import("node:fs/promises");
                const info = await statfs(root);
                const total = BigInt(info.blocks) * BigInt(info.bsize);
                const free = BigInt(info.bavail) * BigInt(info.bsize);
                return { total, free, used: total - free };
            } catch {
                return {};
            }
        },
        dispose: async () => {
            // Nothing to release for the local filesystem.
        }
    };
}

/** Any storage connection: NAS, bucket, or a linked consumer drive. */
async function openConnection(destination: DestinationRow): Promise<DestinationHandle> {
    if (!destination.connectionId) {
        throw new DestinationUnavailableError(`"${destination.name}" names no storage connection`);
    }
    const driver = await getDriverForConnection(destination.connectionId);
    const base = normalizeRelPath(destination.basePath || "polaris-backups");
    const at = (path: string) => (base === "" ? normalizeRelPath(path) : `${base}/${normalizeRelPath(path)}`);
    return {
        put: async (path, body, size) => {
            const target = at(path);
            const parent = target.slice(0, target.lastIndexOf("/"));
            if (parent) await driver.mkdir(parent);
            // The size is passed rather than discovered: OneDrive refuses an
            // upload without a total, and S3 uses it to choose between one PUT
            // and a multipart.
            const entry = await driver.writeStream(target, body, { size });
            return { sizeBytes: Number(entry.size) };
        },
        get: async (path) => driver.readStream(at(path)),
        remove: async (path) => driver.delete(at(path), { recursive: false }),
        usage: async () => (driver.capabilities.usage ? driver.usage() : {}),
        dispose: async () => {
            await driver.dispose();
        }
    };
}

/** A machine already enrolled here, over the SSH credentials Polaris holds. */
async function openHost(destination: DestinationRow, ownerId: string): Promise<DestinationHandle> {
    if (!destination.hostId) {
        throw new DestinationUnavailableError(`"${destination.name}" names no server`);
    }
    const host = await getHostConnection(destination.hostId, ownerId);
    const driver = new SftpDriver({
        id: destination.id,
        host: host.address,
        port: host.port,
        username: host.username,
        root: destination.basePath,
        password: host.auth.password,
        privateKey: host.auth.privateKey,
        passphrase: host.auth.passphrase
    });
    await driver.connect();
    return {
        put: async (path, body, size) => {
            const parent = normalizeRelPath(path).split("/").slice(0, -1).join("/");
            if (parent) await driver.mkdir(parent);
            const entry = await driver.writeStream(normalizeRelPath(path), body, { size });
            return { sizeBytes: Number(entry.size) };
        },
        get: async (path) => driver.readStream(normalizeRelPath(path)),
        remove: async (path) => driver.delete(normalizeRelPath(path), { recursive: false }),
        usage: async () => (driver.capabilities.usage ? driver.usage() : {}),
        dispose: async () => {
            await driver.dispose();
        }
    };
}
