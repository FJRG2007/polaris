/**
 * Reaching a server across the room instead of around the world.
 *
 * A machine enrolled through its public name is recorded at that name, and every
 * connection afterwards takes it: out of Polaris, to the router, back in through
 * the port forward, to a machine that may be on the same switch. It works, which
 * is the problem - nothing looks wrong, it is simply slower than it has any
 * reason to be for every file listing and every byte of every transfer, it
 * depends on the router being willing to hairpin, and it stops entirely when the
 * line does. Which is the afternoon somebody most wants the machine next door.
 *
 * New servers no longer land that way: the enrollment ordering prefers an
 * address on Polaris' own network. This is for the ones already recorded the
 * long way round, and it does the whole thing from the product - the operator
 * does not open a terminal, does not look up the machine's address and does not
 * edit anything. Polaris asks the machine what addresses it has, tries the ones
 * that could be near, and only keeps one that answers as that same machine.
 *
 * And then there is the case that actually happens. A server on a home or office
 * network holds its address on a DHCP lease, the lease moves - a reboot, a router
 * restart, a new device taking the number - and the address Polaris recorded is
 * now somebody else's or nobody's. Every screen says the machine is not
 * answering, which is true of that address and false of the machine, and asking
 * it where it has moved to is asking it at the address that no longer reaches
 * it. The only way out was a terminal, on a product whose first rule is that a
 * terminal is not a requirement for anything.
 *
 * So when it cannot be reached where it should be, Polaris looks for it: the
 * network Polaris is itself on, one port, and every answer checked against the
 * host key this server is already pinned to. It is the machine or it is not.
 *
 * Nothing is trusted along the way, and the host key is why. It is presented
 * during the handshake, before a username or a key is ever offered, so a machine
 * that is not this one fails the check without being handed anything at all -
 * which is what makes both looking and believing what is found safe.
 */

import { prisma } from "@polaris/db";
import { borrowSsh } from "@/lib/connection-pool";
import { getHostLanIp } from "@/lib/host-address";
import { recordAudit } from "@/lib/audit-service";
import { getHostConnection } from "@/lib/host-service";
import { probeTcp } from "@/lib/server-status";
import { execCommand, openSshClient } from "@polaris/ssh";
import { alreadyLocal, localCandidates } from "@polaris/core";

/** What the machine is asked. Both spellings in one command so it costs one
 *  round trip on Linux and on macOS, and neither complains when the other's tool
 *  is missing. */
const READ_ADDRESSES = [
    "ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1",
    "ifconfig 2>/dev/null | awk '/inet /{print $2}'"
].join("; ");

/** Long enough for a machine that is there, short enough that a candidate which
 *  is not costs a moment rather than a minute. Every candidate pays this. */
const REACH_TIMEOUT_MS = 4000;

/** A ceiling on what one machine's answer can be. An address list is a few
 *  lines; anything beyond this is not one. */
const MOST_ADDRESSES = 32;

/**
 * How long an address on our own network gets to answer during a sweep.
 *
 * Deliberately short. A machine on the same switch answers in single-digit
 * milliseconds or is not there at all, and this is paid 254 times - three
 * seconds each would be a wait nobody sits through and an answer nobody waits
 * for.
 */
const SWEEP_TIMEOUT_MS = 400;

/** How many of the sweep's connects are in the air at once. Enough to finish a
 *  /24 in about a second, few enough that Polaris is not mistaken for something
 *  scanning the network. */
const SWEEP_WIDTH = 48;

/**
 * How many machines that answered on the port are then asked for their host key.
 *
 * A handshake is far more expensive than a connect, and a network where more
 * than this many things speak SSH is one where the answer is not going to be
 * found by trying them all anyway.
 */
const MOST_HANDSHAKES = 24;

export type LocalPath =
    /** Polaris does not know its own address on this network, so it cannot say
     *  what is near it. An install without the responder. */
    | { readonly kind: "unknown" }
    /** Already reached directly. Nothing to offer. */
    | { readonly kind: "already"; readonly address: string }
    /** Reached it, and it has nothing on this network - it really is elsewhere. */
    | { readonly kind: "none" }
    /** Could not reach it at all, and it is not on this network either. */
    | { readonly kind: "unreachable" }
    /** An address on this network that answered as this machine. `moved` when it
     *  was found by looking rather than by asking - which means the address on
     *  record had stopped reaching it. */
    | { readonly kind: "found"; readonly address: string; readonly moved: boolean };

/**
 * Whether this server could be reached on the local network, and at what.
 *
 * Owner-scoped through `getHostConnection`, so it cannot be pointed at a machine
 * the caller does not have.
 */
export async function findLocalPath(hostId: string, ownerId: string): Promise<LocalPath> {
    const near = await getHostLanIp().catch(() => null);
    if (!near) return { kind: "unknown" };

    const connection = await getHostConnection(hostId, ownerId);

    let reported: string[];
    try {
        reported = await addressesOf(hostId, connection);
    } catch {
        // Not answering where Polaris knows it, so it cannot be asked where it
        // has gone. This is the DHCP case and it is the common one: look for it
        // instead.
        const found = await sweepForMachine(connection, near);
        return found ? { kind: "found", address: found, moved: true } : { kind: "unreachable" };
    }

    // Asked before this is answered, and that ordering is the point. Being on
    // Polaris' own network says the address is near; it does not say the machine
    // is still at it. Answering "already reached directly" from the address
    // alone is what made this useless in the one case it exists for - a server
    // whose lease moved is recorded at a local address that reaches nothing.
    if (alreadyLocal(connection.address, near)) return { kind: "already", address: connection.address };

    const candidates = localCandidates(reported, near);
    for (const address of candidates) {
        if (await answersAsSameMachine(address, connection)) {
            return { kind: "found", address, moved: false };
        }
    }
    return { kind: "none" };
}

/**
 * Look for this machine on the network Polaris is on.
 *
 * Only where Polaris itself is, only the port this server is recorded on, and
 * only ever as far as a /24 - which is what a home or office network is. It is
 * not a port scan and must not become one: one port, a short wait, and the first
 * machine that presents this server's own host key wins.
 *
 * The host key is what makes this both safe and correct. It is presented during
 * the handshake, before any credential is offered, so the neighbour's NAS that
 * happens to have 22 open is refused without being handed a username - and a
 * machine that does present it is this server, wherever DHCP has put it.
 */
async function sweepForMachine(
    connection: Awaited<ReturnType<typeof getHostConnection>>,
    near: string
): Promise<string | null> {
    const prefix = near.split(".").slice(0, 3).join(".");
    const addresses = Array.from({ length: 254 }, (_, index) => `${prefix}.${index + 1}`).filter(
        // Polaris' own address is not a server to be found: on a host-networked
        // install it is the box this is running on.
        (address) => address !== near && address !== connection.address
    );

    // Which of them answer on the port at all, in waves rather than all at once.
    const open: string[] = [];
    for (let start = 0; start < addresses.length; start += SWEEP_WIDTH) {
        const wave = addresses.slice(start, start + SWEEP_WIDTH);
        const answers = await Promise.all(
            wave.map(async (address) => ({
                address,
                open: (await probeTcp(address, connection.port, SWEEP_TIMEOUT_MS)).detail === null
            }))
        );
        for (const answer of answers) if (answer.open) open.push(answer.address);
        if (open.length >= MOST_HANDSHAKES) break;
    }

    // Then the expensive question, of the few that answered, one at a time: the
    // first machine presenting this server's key is this server, and there is
    // nothing to learn from the ones after it.
    for (const address of open.slice(0, MOST_HANDSHAKES)) {
        if (await answersAsSameMachine(address, connection)) return address;
    }
    return null;
}

/**
 * Start using a local address for this server.
 *
 * Verified again here rather than trusted from the search: the two are separate
 * requests with somebody's decision in between, and what is being written is the
 * address every future connection to this machine will use. A wrong one is a
 * server that has disappeared from the product with no way back that does not
 * involve a terminal - which is the one outcome this whole feature exists to
 * avoid.
 */
export async function useLocalPath(
    hostId: string,
    ownerId: string,
    address: string
): Promise<{ error?: string }> {
    const connection = await getHostConnection(hostId, ownerId);
    if (!(await answersAsSameMachine(address, connection))) {
        return { error: "That address did not answer as this server" };
    }

    await prisma.host.update({ where: { id: hostId }, data: { address } });
    await recordAudit({
        actorId: ownerId,
        action: "server.address",
        targetType: "host",
        targetId: hostId,
        metadata: { from: connection.address, to: address }
    });
    return {};
}

/** What the machine says its own addresses are. Throws when it cannot be
 *  reached, which the caller tells apart from an empty answer. */
async function addressesOf(
    hostId: string,
    connection: Awaited<ReturnType<typeof getHostConnection>>
): Promise<string[]> {
    const lease = await borrowSsh("exec", hostId, {
        host: connection.address,
        port: connection.port,
        username: connection.username,
        auth: connection.auth,
        // An empty array is "pinning required, nothing known", which is refused.
        // Undefined here would silently trust whatever answered.
        pinnedHostKey: connection.hostKey ?? [],
        readyTimeoutMs: REACH_TIMEOUT_MS
    });
    let output = "";
    try {
        await execCommand(lease.client, READ_ADDRESSES, {
            onStdout: (chunk) => {
                output += chunk.toString("utf8");
            }
        });
    } finally {
        lease.release();
    }
    return output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, MOST_ADDRESSES);
}

/**
 * Whether this address is the same machine.
 *
 * The pinned host key is the whole of the check. An address the machine reported
 * could be anything - a typo in its own configuration, a stale lease now held by
 * somebody else's laptop - and this is what makes trusting the report cost
 * nothing: another machine cannot present this one's key.
 *
 * Its own connection rather than a borrowed one: the pool is keyed by machine,
 * and a probe of a candidate address must not become the connection everything
 * else on that machine then borrows.
 */
async function answersAsSameMachine(
    address: string,
    connection: Awaited<ReturnType<typeof getHostConnection>>
): Promise<boolean> {
    let client: Awaited<ReturnType<typeof openSshClient>> | null = null;
    try {
        client = await openSshClient({
            host: address,
            port: connection.port,
            username: connection.username,
            auth: connection.auth,
            pinnedHostKey: connection.hostKey ?? [],
            readyTimeoutMs: REACH_TIMEOUT_MS
        });
        return true;
    } catch {
        return false;
    } finally {
        client?.end();
    }
}
