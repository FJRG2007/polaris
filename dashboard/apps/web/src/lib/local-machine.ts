/**
 * Whether a registered server is, in fact, the machine Polaris itself runs on.
 *
 * Nothing stops an operator enrolling their own box over SSH - it is a server
 * like any other, with files to browse and a shell to open. But Polaris also
 * watches the machine it lives on directly, so that one box arrives twice: once
 * as "Local", once under whatever the operator named it. Sampled through two
 * different paths a few seconds apart, the two then disagree about the same CPU,
 * and the enrolled half usually looks switched off - the local half is measured
 * through the host daemon and answers immediately, while the enrolled half is
 * measured over SSH and reports nothing at all until that path works.
 *
 * Three signals, and any one of them is enough:
 *
 *   1. The enrollment itself, when the machine was added through Polaris's own
 *      "this server" flow. It says so outright and cannot be wrong.
 *   2. The Docker daemon's id: one engine has one id however it is reached. The
 *      collector records both halves while sampling, so this costs nothing extra
 *      and self-corrects if a server is re-pointed somewhere else. It only ever
 *      arrives for a server the collector can reach over SSH, which is exactly the
 *      server that looks switched off - so it cannot be the only signal.
 *   3. The address it was enrolled at, against the address this machine answers
 *      on. Nothing else can be reached at our own LAN address, and unlike the
 *      daemon id it is known before anything has been sampled.
 *
 * Resolved once per render and passed to `isLocalMachine`, which is pure.
 */

import { prisma } from "@polaris/db";
import { getHostLanIp } from "./host-address";
import { getLocalHostId } from "./local-server";

/** Where the local daemon's id is kept. It has no Host row to hang off. */
const LOCAL_DOCKER_ID_KEY = "metrics.localDockerId";

/** Addresses that always mean "the machine serving this request". */
const LOOPBACK = ["127.0.0.1", "::1", "localhost", "host.docker.internal"];

export interface LocalMachineIdentity {
    /** The server row the local enrollment claimed, when the box was enrolled
     *  through Polaris's own flow rather than added by hand. */
    hostId: string | null;
    dockerId: string | null;
    /** Every address this machine answers on, lowercased. */
    addresses: ReadonlySet<string>;
}

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
 * Everything known about which server is this one. Each part is read from
 * somewhere that may have nothing to say yet - a fresh install has no daemon id,
 * a hand-added server has no enrollment, and an install without the mDNS
 * responder never learns its own address - so a missing one is silence rather
 * than a negative answer.
 */
export async function localMachineIdentity(): Promise<LocalMachineIdentity> {
    const [hostId, dockerId, lanIp] = await Promise.all([
        getLocalHostId().catch(() => null),
        localDockerId().catch(() => null),
        getHostLanIp().catch(() => null)
    ]);
    return {
        hostId,
        dockerId,
        addresses: new Set([...LOOPBACK, ...(lanIp ? [lanIp] : [])].map((address) => address.toLowerCase()))
    };
}

/**
 * True when this server is the machine Polaris runs on.
 *
 * Deliberately not a guess: an unidentified server is left alone, because
 * merging one that is not this machine hides a real server, which is worse than
 * briefly showing this one twice.
 */
export function isLocalMachine(
    host: { id?: string; dockerId?: string | null; address?: string | null },
    identity: LocalMachineIdentity
): boolean {
    if (identity.hostId && host.id === identity.hostId) return true;
    if (identity.dockerId && host.dockerId && host.dockerId === identity.dockerId) return true;
    const address = host.address?.trim().toLowerCase();
    return Boolean(address && identity.addresses.has(address));
}
