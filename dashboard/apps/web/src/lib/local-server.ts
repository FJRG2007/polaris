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
const HOST_KEY = "server.localHostId";

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

/**
 * The Host row for the box Polaris runs on, once somebody has enrolled it, or null.
 *
 * Polaris runs in a container and reaches its own machine only through the host
 * daemon, which starts containers and nothing else - so a shell on it, or its
 * filesystem in Drive, needs a way in that the daemon deliberately does not offer.
 * Enrolling the machine the same way as any other gives it one, and this is the
 * pointer that keeps the result from showing up as a second server: the Servers
 * app folds that host into the row it already shows for this machine.
 */
export async function getLocalHostId(): Promise<string | null> {
    return getSetting(HOST_KEY);
}

/** Point the local row at the host that just claimed the local enrollment. */
export async function setLocalHostId(hostId: string | null): Promise<void> {
    await setSetting(HOST_KEY, hostId);
}

/**
 * What the box calls itself, without asking anything.
 *
 * `hostname()` is a syscall - no socket, no container engine, no timeout - and on
 * essentially every deployment it is the same string `localMachineName` ends up
 * returning, because the engine's node name is the hostname unless somebody has
 * deliberately set it otherwise.
 *
 * That makes it the right thing to render with. The Servers screen used to draw a
 * skeleton where this line goes and wait for the status endpoint, which meant a
 * grey bar sitting under the name of a machine whose name was already on the
 * page - a loading state for a fact that does not change and did not need
 * fetching. The live answer still arrives and still replaces this, so a machine
 * that has been given a different engine name is right a moment later, in the
 * same place and without the row moving.
 */
export function localMachineNameNow(): string {
    return hostname();
}

/** The name the machine calls itself, as the engine reports it. Best-effort and
 *  time-boxed; falls back to the hostname, which is what it almost always is. */
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
