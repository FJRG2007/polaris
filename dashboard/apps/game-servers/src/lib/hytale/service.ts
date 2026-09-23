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
import { HYTALE_ASSETS, HYTALE_JAR, type HytaleFiles } from "./paths";

// The constants and the shape of the answer are in `paths.ts` and are NOT
// re-exported from here. A screen needs them, and this file reaches a container -
// so an import of one constant from here is the deploy stack, node's own crypto
// and everything behind them in the browser half of the app bundle, which is a
// build that fails rather than a warning. Leaving the only route through
// `paths.ts` is what keeps that from happening twice.

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
