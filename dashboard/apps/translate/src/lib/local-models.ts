/**
 * The local engine's model files, kept on Polaris's data volume. A file is
 * downloaded from the pinned mirror the first time anyone asks for it, checked
 * against the size and sha256 in `model/local-registry.ts`, and kept under its
 * hash - so it survives updates, is never fetched twice, and a reader on the
 * LAN needs no internet after that first time.
 *
 * The address is never a caller's: it is built from a fixed origin, the pinned
 * revision and a file the route already matched against the registry. The
 * download is bounded (time and bytes) and refused unless every byte matches.
 *
 * Server-only.
 */

import path from "node:path";
import { loadEnv } from "@polaris/config";
import { createWriteStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { upstreamUrl, LOCAL_MODEL_ORIGIN, type LocalModelFile } from "../model/local-models";

/** Long enough for the largest model (about 44 MB) on a slow line. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** Thrown when the mirror could not be reached or sent something else. */
export class ModelDownloadError extends Error {
    public constructor(reason: string) {
        super(reason);
        this.name = "ModelDownloadError";
    }
}

/** Where the files live: on the data volume. Overridable for a checkout and tests. */
export function modelDir(): string {
    return (
        process.env.POLARIS_TRANSLATE_MODELS_DIR ||
        path.join(loadEnv().POLARIS_DATA_DIR, "translate-models")
    );
}

/** A file's place on disk, by its hash. */
export function modelPath(file: LocalModelFile): string {
    return path.join(modelDir(), file.sha256);
}

async function present(file: LocalModelFile): Promise<boolean> {
    try {
        return (await stat(modelPath(file))).size === file.size;
    } catch {
        return false;
    }
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

async function download(pair: string, file: LocalModelFile, fetcher: Fetcher): Promise<void> {
    const response = await fetcher(upstreamUrl(pair, file), {
        redirect: "follow",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    }).catch((caught: unknown) => {
        throw new ModelDownloadError(caught instanceof Error ? caught.message : "unreachable");
    });
    // The mirror hands the bytes to its CDN; every hop has to stay on https.
    const landed = response.url ? new URL(response.url) : new URL(LOCAL_MODEL_ORIGIN);
    if (!response.ok || !response.body || landed.protocol !== "https:") {
        await response.body?.cancel().catch(() => undefined);
        throw new ModelDownloadError(`status ${response.status}`);
    }
    await mkdir(modelDir(), { recursive: true });
    const part = path.join(modelDir(), `.${file.sha256}.${randomUUID()}.part`);
    const hash = createHash("sha256");
    const out = createWriteStream(part);
    let size = 0;
    try {
        const reader = response.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > file.size) {
                await reader.cancel().catch(() => undefined);
                throw new ModelDownloadError("too large");
            }
            hash.update(value);
            if (!out.write(value)) await new Promise((resolve) => out.once("drain", resolve));
        }
        await new Promise<void>((resolve, reject) =>
            out.end((error?: Error | null) => (error ? reject(error) : resolve()))
        );
        if (size !== file.size || hash.digest("hex") !== file.sha256) {
            throw new ModelDownloadError("checksum");
        }
        await rename(part, modelPath(file));
    } catch (caught) {
        // Closed before it is removed: a stream still opening would otherwise
        // create the file again after it was deleted.
        if (!out.closed) await new Promise((resolve) => out.destroy().once("close", resolve));
        await rm(part, { force: true }).catch(() => undefined);
        throw caught;
    }
}

const pending = new Map<string, Promise<void>>();

/**
 * The file on disk, downloading it first when it is not there yet. Readers
 * asking for the same file at once share one download.
 */
export async function ensureModelFile(
    pair: string,
    file: LocalModelFile,
    fetcher: Fetcher = (url, init) => fetch(url, init)
): Promise<string> {
    if (await present(file)) return modelPath(file);
    let running = pending.get(file.sha256);
    if (!running) {
        running = download(pair, file, fetcher).finally(() => pending.delete(file.sha256));
        pending.set(file.sha256, running);
    }
    await running;
    return modelPath(file);
}
