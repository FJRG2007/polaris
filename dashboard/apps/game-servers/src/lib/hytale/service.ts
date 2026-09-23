/**
 * What a Hytale server needs before it is a server at all.
 *
 * Every other game here installs itself: the image carries the server, or
 * downloads it from somewhere anybody may download it from. Hytale does not.
 * Its files come from the operator's own account - the launcher's installation,
 * or the official downloader signed in as them - and nothing Polaris runs is
 * allowed to fetch them on their behalf.
 *
 * So the one question this file answers is which of the two files have arrived,
 * because that is the difference between a server that is starting and a server
 * that is waiting for somebody. The container asks the same question in its
 * entrypoint and waits; this is so the screen can say it rather than leaving
 * somebody reading a log.
 */

import { withServerContainer } from "../minecraft/service";
import { readContainerFileState } from "../container-files";

/** The manifest a Hytale server is created from. */
export const HYTALE_CATALOG_ID = "hytale";

/** Where the image looks for them, which is the top of the volume. */
export const HYTALE_ROOT = "/data";
export const HYTALE_JAR = `${HYTALE_ROOT}/HytaleServer.jar`;
export const HYTALE_ASSETS = `${HYTALE_ROOT}/Assets.zip`;

/** The port a Hytale client reaches a server on. QUIC, so UDP and nothing else. */
export const HYTALE_PORT = 5520;

export interface HytaleFiles {
    readonly jar: boolean;
    readonly assets: boolean;
    /**
     * Whether the answer is worth trusting.
     *
     * A container that is not up has its volumes read by borrowing them, which
     * works - but a machine that will not answer at all is a different thing from
     * a file that is not there, and a screen that turned one into "put your files
     * in" would be asking somebody to fix what is already correct.
     */
    readonly read: boolean;
}

export async function readHytaleFiles(ownerId: string, installedAppId: string): Promise<HytaleFiles> {
    return withServerContainer(ownerId, installedAppId, async (server) => {
        const [jar, assets] = await Promise.all([
            readContainerFileState(server, HYTALE_JAR),
            readContainerFileState(server, HYTALE_ASSETS)
        ]);
        // `unreadable` is the one state that must not read as absent: it is the
        // machine, not the file.
        const read = jar.state !== "unreadable" && assets.state !== "unreadable";
        return { jar: jar.state === "read", assets: assets.state === "read", read };
    });
}
