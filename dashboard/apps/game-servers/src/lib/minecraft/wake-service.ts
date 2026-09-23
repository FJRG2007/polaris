/**
 * Starting a server because somebody tried to join it.
 *
 * A schedule that sleeps a server gives its memory back, and until now that was
 * one-way: coming back meant a window that says "on", or a person opening Polaris
 * and pressing start. That is the half of "sleep when nobody is playing" that
 * makes people not use it - the players cannot start it, and the owner is not
 * always there.
 *
 * The router already sees the attempt. A Java client names the address it dialled
 * in the handshake, in the clear, before it logs in, which is what lets one port
 * serve every server by name (`router-service.ts`). mc-router can be told to
 * report a connection to a backend that is down, and it reports it here: a POST
 * saying which name was dialled. Polaris decides what to do about it, so the
 * router needs no Docker socket, no token and no authority of its own - it is
 * telling us somebody knocked.
 *
 * Deliberately only ever starts. A stop is a decision about the people playing,
 * and the schedule sweep is what knows that; taking "nobody is connected through
 * me" from the router as a reason to stop a server would stop one that players
 * reached on its own port.
 *
 * A status ping never reaches here - the router answers the server list itself
 * with the asleep message - so a client sitting on the multiplayer screen does
 * not keep waking an empty world.
 */

import { prisma } from "@polaris/db";
import { routesByHostname } from "@polaris/core";
import { readSchedule, scheduleModeAt, wakesOnJoin, WOKEN_AT_KEY } from "./schedule";
import { host } from "@polaris/app-host";

const { setApplicationRunning } = host.deployService;
const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;

/**
 * What became of a knock. Every one is a normal outcome except `failed`, and the
 * caller answers the router the same way whichever it is: the router's job is to
 * wait for the port, not to be told whose server it is.
 */
export type WakeOutcome =
    | "started"
    /** Already up - the player's connection is about to succeed on its own. */
    | "running"
    /** No routed server answers to that name here. */
    | "unknown"
    /** The owner turned waking off for this one. */
    | "refused"
    /** The schedule says this server is to be kept stopped right now. */
    | "kept-stopped"
    | "failed";

/**
 * The routed server a dialled name belongs to.
 *
 * Read the same way the routing table is built rather than by query, because
 * "routed" and the name itself live in the install's settings blob: this is one
 * short list on any real instance, and it is read only when somebody knocks on a
 * server that is down.
 */
async function serverNamed(hostname: string): Promise<{
    id: string;
    ownerId: string;
    applicationId: string;
    config: Record<string, unknown>;
} | null> {
    const name = hostname.trim().toLowerCase();
    if (!name) return null;
    const installs = await prisma.installedApp.findMany({
        where: { status: { not: "removed" }, applicationId: { not: null } },
        select: { id: true, ownerId: true, applicationId: true, catalogId: true, config: true }
    });
    for (const install of installs) {
        if (!routesByHostname(install.catalogId)) continue;
        const config = readInstallConfig(install.config);
        if (config.routed !== true) continue;
        const named = typeof config.hostname === "string" ? config.hostname.trim().toLowerCase() : "";
        if (named !== name) continue;
        return {
            id: install.id,
            ownerId: install.ownerId,
            applicationId: install.applicationId as string,
            config
        };
    }
    return null;
}

/** Somebody tried to join `hostname` and nothing answered there. Start it, if that
 *  is what this server's owner asked for. */
export async function wakeForJoin(hostname: string, now: Date = new Date()): Promise<WakeOutcome> {
    const server = await serverNamed(hostname);
    if (!server) return "unknown";
    if (!wakesOnJoin(server.config)) return "refused";

    // "Keep stopped" is the one window that means it, and a player knocking is not
    // a reason to overrule the person who wrote it. Sleep and no schedule at all
    // both allow the start - sleeping is permission to go quiet, not to stay down.
    const schedule = readSchedule(server.config);
    if (schedule.enabled && scheduleModeAt(schedule, now) === "off") return "kept-stopped";

    const app = await prisma.application
        .findUnique({ where: { id: server.applicationId }, select: { desiredState: true } })
        .catch(() => null);
    if (!app) return "unknown";
    if (app.desiredState === "running") return "running";

    const started = await setApplicationRunning(server.applicationId, server.ownerId, true)
        .then(() => true)
        .catch(() => false);
    if (!started) return "failed";
    await patchInstallConfig(server.id, { [WOKEN_AT_KEY]: now.toISOString() }).catch(() => undefined);
    return "started";
}
