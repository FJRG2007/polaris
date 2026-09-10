/**
 * Where large things wait on Polaris's own disk on their way somewhere else: an
 * image carried from the machine that built it to the one that runs it, an image
 * uploaded from somebody's own machine, a folder uploaded as a service's source.
 *
 * On the data volume rather than the container's own filesystem, because these
 * run to gigabytes and the container's layer is not where anything that size
 * should land. Every file here is named uniquely and removed by whoever made it.
 */

import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadEnv } from "@polaris/config";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";

/** The directory staged files wait in. */
export function stagingDir(): string {
    return join(loadEnv().POLARIS_DATA_DIR, "deploy-staging");
}

/** A fresh path in the staging directory, with the directory made. */
export async function stagedPath(extension: string): Promise<string> {
    const dir = stagingDir();
    await mkdir(dir, { recursive: true });
    return join(dir, `${randomUUID()}${extension}`);
}

/** What a body was refused for being larger than it may be. */
export class TooLarge extends Error {
    public constructor(public readonly limit: number) {
        super(`larger than ${Math.round(limit / 1024 ** 2)} MB`);
    }
}

/**
 * Write a request body to `file`, at most `max` bytes, and answer how many there
 * were. Streamed: nothing but the chunk in flight is held. A body that runs past
 * the limit stops there, and the partial file is removed.
 */
export async function stageBody(body: ReadableStream<Uint8Array> | null, file: string, max: number): Promise<number> {
    if (!body) throw new Error("nothing was sent");
    let bytes = 0;
    const counted = new Transform({
        transform(chunk: Buffer, _encoding, done) {
            bytes += chunk.length;
            if (bytes > max) {
                done(new TooLarge(max));
                return;
            }
            done(null, chunk);
        }
    });
    try {
        await pipeline(Readable.fromWeb(body as never), counted, createWriteStream(file));
    } catch (error) {
        await rm(file, { force: true });
        throw error;
    }
    return bytes;
}
