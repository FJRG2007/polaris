/**
 * The icon a Minecraft server is carrying (`server-icon.png`), read back out of
 * its container - the only place it lives.
 *
 * Null for a server with no icon, a stopped container or a remote one: none of
 * those is a failure, and every caller draws something else instead.
 */

import { host } from "@polaris/app-host";

const { readContainerFile } = host.containerFilesService;

/** Where the image writes the server's icon, and where the game reads it from. */
export const ICON_PATH = "/data/server-icon.png";

export async function readServerIcon(applicationId: string, ownerId: string): Promise<Buffer | null> {
    try {
        const stream = await readContainerFile(applicationId, ownerId, ICON_PATH);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
        const bytes = Buffer.concat(chunks);
        // `cat` on a path that is not there exits non-zero and prints to stderr,
        // which reaches here as an empty body rather than as a throw.
        return bytes.length > 0 && isPng(bytes) ? bytes : null;
    } catch {
        return null;
    }
}

/** The eight bytes every PNG starts with, so a shell error never renders as one. */
function isPng(bytes: Buffer): boolean {
    return bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}
