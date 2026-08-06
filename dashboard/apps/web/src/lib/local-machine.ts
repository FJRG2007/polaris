/**
 * Whether a registered server is, in fact, the machine Polaris itself runs on.
 *
 * Nothing stops an operator enrolling their own box over SSH - it is a server
 * like any other, with files to browse and a shell to open. But Polaris also
 * monitors the machine it lives on directly, so that one box arrives twice: once
 * as "Local", once under whatever the operator named it. Sampled through two
 * different paths a few seconds apart, the two cards then disagree about the same
 * CPU, which reads as two servers rather than as one counted twice.
 *
 * The Docker daemon's id settles it: one engine has one id however it is reached.
 * Both halves are recorded by the metrics collector, which already asks every
 * machine for its daemon info every minute - so identity costs nothing extra and
 * self-corrects if a server is ever re-pointed somewhere else.
 */

import { prisma } from "@polaris/db";

/** Where the local daemon's id is kept. It has no Host row to hang off. */
const LOCAL_DOCKER_ID_KEY = "metrics.localDockerId";

/** Remember the daemon id of the machine Polaris runs on. */
export async function recordLocalDockerId(dockerId: string): Promise<void> {
    if (!dockerId) return;
    await prisma.setting.upsert({
        where: { key: LOCAL_DOCKER_ID_KEY },
        create: { key: LOCAL_DOCKER_ID_KEY, value: dockerId, scope: "global" },
        update: { value: dockerId }
    });
}

/** Remember which daemon a registered server turned out to be running. */
export async function recordHostDockerId(hostId: string, dockerId: string): Promise<void> {
    if (!dockerId) return;
    // Only on a change: this runs once per host per minute, and the row is read
    // on every Watch render.
    await prisma.host.updateMany({ where: { id: hostId, dockerId: { not: dockerId } }, data: { dockerId } });
}

/** The daemon id of the machine Polaris runs on, or null before it has been
 *  sampled. Callers compare it against a host's own `dockerId`. */
export async function localDockerId(): Promise<string | null> {
    const row = await prisma.setting.findUnique({ where: { key: LOCAL_DOCKER_ID_KEY }, select: { value: true } });
    return row?.value || null;
}

/**
 * True when this server is the machine Polaris runs on. Both ids must be present
 * and equal - an unsampled server is not assumed to be anything, because guessing
 * wrong here hides a real server rather than merely showing one twice.
 */
export function isLocalMachine(host: { dockerId: string | null }, localId: string | null): boolean {
    return localId != null && host.dockerId != null && host.dockerId === localId;
}
