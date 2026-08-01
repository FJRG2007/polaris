/**
 * The box Polaris runs on, treated as a server in its own right.
 *
 * It has no Host row - there are no credentials to store for the machine serving
 * the request - so the few things that would otherwise live on that row live
 * here: the id every picker uses for it, the operator's name for it, and the
 * machine name to fall back on.
 *
 * Reading the machine name goes through the container engine on purpose. Inside a
 * container `os.hostname()` is the container id, while the engine reports the
 * name of the host it runs on, which is the name the operator knows the box by.
 */

import { hostname } from "node:os";
import { localDockerDriver } from "./docker-service";
import { getSetting, setSetting } from "./setting-store";

export { LOCAL_SERVER_ID } from "@polaris/core";

/** What the table calls it when the operator has not named it. */
export const LOCAL_SERVER_FALLBACK_NAME = "This server";

const NAME_KEY = "server.localName";

/** How long the engine gets to answer before the caller settles for os.hostname().
 *  A wedged daemon answers neither success nor error, and a label is not worth
 *  waiting on one. */
const NAME_TIMEOUT_MS = 2000;

/** The operator's name for the local box, or null while they have not set one. */
export async function getLocalServerName(): Promise<string | null> {
    return getSetting(NAME_KEY);
}

/** Name the local box. Blank forgets the name, so it reads as the default again. */
export async function setLocalServerName(name: string): Promise<void> {
    await setSetting(NAME_KEY, name.trim() || null);
}

/** The name the machine calls itself. Best-effort and time-boxed. */
export async function localMachineName(): Promise<string> {
    try {
        const driver = localDockerDriver();
        try {
            // The losing info() promise is abandoned but still settles when
            // dispose() tears the transport down; without its own catch that
            // rejection lands unhandled (fatal in Node) every time it is slow.
            const info = await Promise.race([
                driver.info().catch(() => null),
                new Promise<null>((resolve) => setTimeout(() => resolve(null), NAME_TIMEOUT_MS))
            ]);
            return info?.name || hostname();
        } finally {
            await driver.dispose();
        }
    } catch {
        return hostname();
    }
}
