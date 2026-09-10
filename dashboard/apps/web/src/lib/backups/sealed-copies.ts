/**
 * Where sealing meets the backup engine: a staged artifact sealed before it is
 * written anywhere, and a copy opened as it is read back.
 *
 * Every copy that leaves the thing it protects is sealed - the data dir, a bucket,
 * a linked drive, another server. The only copies written in the clear are the
 * ones a game server keeps on its own disk, beside the world they copy: sealing
 * those would protect nothing the disk does not already hold in the open.
 */

import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { keyById, sealingKey } from "./keyring";
import { PassThrough, Readable } from "node:stream";
import { createReadStream, createWriteStream } from "node:fs";
import { stageDir, stagedFrom, type StagedArtifact } from "./sources/types";
import { keyringFileKey, newHeader, openStream, SealError, sealStream } from "./sealing";

/** What a sealed copy's name ends in. */
export const SEALED_SUFFIX = ".sealed";

/** The name a copy is downloaded or restored under: the source's own. */
export function plainName(fileName: string): string {
    return fileName.endsWith(SEALED_SUFFIX) ? fileName.slice(0, -SEALED_SUFFIX.length) : fileName;
}

/** Whether a stored copy is sealed: recorded on the row, or named so by its path. */
export function isSealedCopy(copy: { sealedWith: string | null; path: string }): boolean {
    return copy.sealedWith !== null || copy.path.endsWith(SEALED_SUFFIX);
}

/**
 * Seal a staged artifact under the owner's current backup key. The sealed file is
 * staged beside it and cleaned up on its own; the plain one is still the caller's.
 */
export async function sealArtifact(
    staged: StagedArtifact,
    ownerId: string
): Promise<{ artifact: StagedArtifact; keyId: string }> {
    const { id, key } = await sealingKey(ownerId);
    const header = newHeader("keyring", id);
    const dir = await stageDir();
    const fileName = `${staged.fileName}${SEALED_SUFFIX}`;
    const target = join(dir, fileName);
    await pipeline(
        createReadStream(staged.path),
        sealStream(header, keyringFileKey(key, header)),
        createWriteStream(target)
    );
    return { artifact: await stagedFrom(dir, target, fileName, staged.metadata), keyId: id };
}

/**
 * Open a sealed copy as it streams. The key is the one its header names, looked
 * up on the owner's ring, so a copy sealed under a retired key opens the same way.
 */
export function openSealed(
    ownerId: string,
    body: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
    const opener = openStream(async (header) => {
        if (header.kdf !== "keyring")
            throw new SealError("That copy was sealed with a passphrase, not a backup key");
        return keyringFileKey(await keyById(ownerId, header.keyId), header);
    });
    const out = new PassThrough();
    // A failure anywhere ends the output with that error, so a download or a
    // restore stops rather than carrying on with bytes that did not verify.
    void pipeline(
        Readable.fromWeb(body as import("node:stream/web").ReadableStream),
        opener,
        out
    ).catch(() => undefined);
    return Readable.toWeb(out) as ReadableStream<Uint8Array>;
}
