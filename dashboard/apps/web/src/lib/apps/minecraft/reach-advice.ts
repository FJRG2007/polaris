/**
 * What is still in the way of players outside the network, said in words.
 *
 * Pure on purpose, and split from `reach.ts` for the same reason `port-block.ts`
 * is split from its store: the Domains card renders these in the browser, and the
 * rest of reaching a game server is sockets and the database, none of which may be
 * dragged into a client bundle to print "TCP 25565".
 *
 * A deployed site and a game server look the same from inside Polaris and are not
 * the same at all from the internet: the site rides on 80 and 443, which the domain
 * setup already walks the operator through opening, while a game server answers on
 * a port of its own that nothing has ever asked anyone to open. So a server can be
 * running, its DNS perfect and its address printed on the page, and every player
 * still gets a timeout - which is exactly the failure this exists to name.
 */

import type { ServerEnvironment } from "@polaris/core";
import { describeBlock, DEFAULT_PORT_BLOCKS, type PortBlocks, type PortPolicy } from "@/lib/apps/port-block";

/** One port a game server answers on, as the router has to be told it. */
export interface GamePort {
    readonly port: number;
    readonly protocol: "tcp" | "udp";
}

export interface GameReachAdvice {
    /** Nothing left to open, or nothing that can be judged as open. */
    readonly ok: boolean;
    /** True while the operator has something to do about it. */
    readonly actionable: boolean;
    readonly title: string;
    readonly detail: string;
    readonly steps: readonly string[];
    /** Whether a port forward is the thing missing, so the panel can offer the
     *  router walkthrough rather than a firewall instruction. */
    readonly forward: boolean;
}

/**
 * How the ports read in a sentence: "TCP 25565", "TCP 25565 and UDP 19132", or
 * "UDP 19133-19135" for a game that publishes a run of them.
 *
 * Collapsed because ARK publishes three consecutive ports and naming each one
 * three times over made every sentence about them unreadable - and a router asks
 * for the range anyway.
 */
export function describePorts(ports: readonly GamePort[]): string {
    const parts = (["tcp", "udp"] as const).flatMap((protocol) => {
        const numbers = [...new Set(ports.filter((entry) => entry.protocol === protocol).map((entry) => entry.port))];
        return runsOf(numbers).map((run) => `${protocol.toUpperCase()} ${run}`);
    });
    if (parts.length <= 1) return parts[0] ?? "its port";
    return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** Consecutive numbers as ranges, everything else as itself. */
function runsOf(numbers: readonly number[]): string[] {
    const sorted = [...numbers].sort((left, right) => left - right);
    const runs: string[] = [];
    for (let index = 0; index < sorted.length; ) {
        let end = index;
        while (end + 1 < sorted.length && (sorted[end + 1] as number) === (sorted[end] as number) + 1) end += 1;
        runs.push(end === index ? `${sorted[index]}` : `${sorted[index]}-${sorted[end]}`);
        index = end + 1;
    }
    return runs;
}

/** Whether the sentence about these ports is about more than one of them, so the
 *  verb beside it agrees. "UDP 19133-19135 is not confirmed" reads as a mistake,
 *  because it is one. */
function plural(ports: readonly GamePort[]): boolean {
    return new Set(ports.map((entry) => entry.port)).size > 1;
}

/** The same sentence for the blocks these ports come from, which is what the
 *  range policy asks the operator to open: "TCP 25565-25664 and UDP 19132-19231". */
export function describeBlocksFor(ports: readonly GamePort[], blocks: PortBlocks): string {
    const used = (["tcp", "udp"] as const).filter((protocol) => ports.some((entry) => entry.protocol === protocol));
    const parts = used.map((protocol) => `${protocol.toUpperCase()} ${describeBlock(blocks[protocol])}`);
    if (parts.length <= 1) return parts[0] ?? "its range";
    return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** A server that publishes nothing has nothing to say about a router, whichever
 *  of the two questions below was asked. */
const NO_PORTS: GameReachAdvice = {
    ok: true,
    actionable: false,
    title: "No published port",
    detail: "This server publishes no port, so there is nothing to open.",
    steps: [],
    forward: false
};

/**
 * What to say about a server that is stopped and has never been proven.
 *
 * A different question from the advice below, and one that has to be asked first:
 * nothing on this machine can tell an open port from a closed one while nothing is
 * listening behind it. Judging a stopped server is how a port that was forwarded
 * months ago reads as unopened every time its server is turned off - and a page
 * that sends somebody into their router over that has spent their trust on nothing.
 *
 * So this claims nothing either way. What was already proven is not reached
 * through here at all: that answer is kept, and a stopped server that has been
 * reached stays reached.
 */
export function gameStoppedAdvice(ports: readonly GamePort[]): GameReachAdvice {
    if (ports.length === 0) return NO_PORTS;
    const named = describePorts(ports);
    return {
        ok: false,
        actionable: false,
        title: plural(ports) ? "Stopped, so its ports cannot be checked" : "Stopped, so its port cannot be checked",
        detail: `Nothing answers on ${named} while this server is down, and from here that looks exactly like a port nobody has opened. Start it and Polaris checks this by itself.`,
        steps: [],
        forward: false
    };
}

/**
 * What still has to happen for players outside the network to get in.
 *
 * It says "confirmed" for one reason only: something arrived. Everything else is
 * phrased as unconfirmed rather than broken, because from in here the two are
 * indistinguishable and telling an operator their working server is down is the
 * more expensive mistake.
 *
 * Ask this about a server that is up. A stopped one is `gameStoppedAdvice`, which
 * is the same refusal to guess taken one step earlier.
 */
export function gameReachAdvice(
    environment: ServerEnvironment,
    ports: readonly GamePort[],
    confirmed: boolean,
    lanIp: string | null = null,
    policy: PortPolicy = "per-port",
    blocks: PortBlocks = DEFAULT_PORT_BLOCKS,
    /** Whether anything is listening on the port here, on this network. Null when
     *  it was not checked. */
    listening: boolean | null = null
): GameReachAdvice {
    if (ports.length === 0) return NO_PORTS;
    const named = describePorts(ports);
    const many = plural(ports);
    if (confirmed) {
        return {
            ok: true,
            actionable: false,
            title: "Reachable from the internet",
            detail: `Players have connected to this server from outside the network, so ${named} reaches it.`,
            steps: [],
            forward: false
        };
    }
    // Nothing is listening here, so nothing outside could have answered either -
    // and there is no evidence about the router one way or the other. Telling the
    // operator to forward a port at this point is a demand built on a missing
    // answer, which is exactly how somebody ends up opening a port that was open
    // all along and watching it tick itself minutes later, once the server had
    // finished starting.
    if (listening === false) {
        return {
            ok: false,
            actionable: false,
            title: "Not answering yet, so its port cannot be checked",
            detail: `Nothing is listening on ${named} here, so whether it reaches this machine from outside cannot be told apart from the server being down. Start it - or wait for it to finish generating its world - and this checks itself.`,
            steps: [],
            forward: false
        };
    }
    if (environment === "home-cgnat") {
        return {
            ok: false,
            actionable: true,
            title: "This line cannot receive incoming connections",
            detail: `Your provider puts this connection behind carrier-grade NAT, so no forward can open ${named} - the public address is shared and it is not yours to open.`,
            steps: [
                "Ask your provider for a public IP address, which some offer on request.",
                "Until then the server is reachable on this network only, at its LAN address."
            ],
            forward: false
        };
    }
    if (environment === "home-nat") {
        const ranged = policy === "range";
        return {
            ok: false,
            actionable: true,
            // Not "has to be forwarded". From in here a forward that exists and one
            // that does not look identical - most routers will not loop their own
            // public address back inward - so the only honest claim is that nothing
            // has proved it yet.
            title: `${named} ${many ? "are" : "is"} not confirmed from outside yet`,
            detail: `The domain setup opens 80 and 443 for websites; ${named} ${many ? "are this server's own ports and ride" : "is this server's own port and rides"} on none of that. Polaris cannot prove a forward from inside the network, so if you have already opened ${many ? "them" : "it"}, this clears itself the first time somebody joins from outside.`,
            steps: [
                ranged
                    ? `If ${many ? "they are" : "it is"} not open yet, forward ${describeBlocksFor(ports, blocks)} to ${lanIp ?? "this server"} on your router. Polaris keeps every game server inside that range, so this is the last time it has to be opened.`
                    : `If ${many ? "they are" : "it is"} not open yet, forward ${named} to ${lanIp ?? "this server"} on your router.`,
                "Polaris marks this done by itself the moment the port answers from outside, or the first time somebody joins on it."
            ],
            forward: true
        };
    }
    if (environment === "vps" || environment === "cloud") {
        return {
            ok: false,
            actionable: true,
            title: `${named} ${many ? "are" : "is"} not confirmed from outside yet`,
            detail: `This server holds its own public address, so nothing has to be forwarded - but the provider's firewall or security group has to let ${named} in, and from in here an allowed port and a blocked one look the same until something arrives.`,
            steps: [
                `If ${many ? "they are" : "it is"} not allowed yet, allow inbound ${named} in your provider's firewall or security group.`,
                "Polaris marks this done by itself the moment the port answers from outside, or the first time somebody joins on it."
            ],
            forward: false
        };
    }
    return {
        ok: false,
        actionable: false,
        title: `${named} may not be reachable yet`,
        detail: `Polaris does not know where this machine sits on the network, so it cannot say what has to be opened for ${named}. Set it under Admin, Domains.`,
        steps: [],
        forward: false
    };
}
