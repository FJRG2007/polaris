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
 * Nothing is trusted along the way. The addresses come from the machine, so a
 * candidate is accepted only when it presents the host key this server is
 * already pinned to - which is the same check every other connection to it makes,
 * and means the worst a wrong answer can do is fail to connect.
 */

import { prisma } from "@polaris/db";
import { borrowSsh } from "@/lib/connection-pool";
import { getHostLanIp } from "@/lib/host-address";
import { recordAudit } from "@/lib/audit-service";
import { getHostConnection } from "@/lib/host-service";
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

export type LocalPath =
    /** Polaris does not know its own address on this network, so it cannot say
     *  what is near it. An install without the responder. */
    | { readonly kind: "unknown" }
    /** Already reached directly. Nothing to offer. */
    | { readonly kind: "already"; readonly address: string }
    /** Reached it, and it has nothing on this network - it really is elsewhere. */
    | { readonly kind: "none" }
    /** Could not reach it at all, so this question cannot be answered right now. */
    | { readonly kind: "unreachable" }
    /** An address on this network that answered as this machine. */
    | { readonly kind: "found"; readonly address: string };

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
    if (alreadyLocal(connection.address, near)) return { kind: "already", address: connection.address };

    let reported: string[];
    try {
        reported = await addressesOf(hostId, connection);
    } catch {
        // The machine is not answering where Polaris knows it. Saying so is the
        // honest answer: the local address it might have is not knowable from
        // here, and reporting "nothing found" would read as a fact about the
        // machine rather than about this moment.
        return { kind: "unreachable" };
    }

    const candidates = localCandidates(reported, near);
    for (const address of candidates) {
        if (await answersAsSameMachine(address, connection)) return { kind: "found", address };
    }
    return { kind: "none" };
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
