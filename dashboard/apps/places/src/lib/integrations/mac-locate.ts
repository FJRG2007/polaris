/**
 * Where a device given by its hardware (MAC) address is on the network now.
 *
 * Plenty of makers' apps show a device's MAC and never its IP (Gree+ lists twelve
 * bare digits), and every router lends the IP again on a whim. So any address
 * field takes a MAC (`ConnectionField.address`), the MAC is what is stored, and
 * this turns it into the IP the device answers on at the moment it is needed.
 *
 * Where the answer comes from, cheapest first, the same as a NAS that moved is
 * looked for (`storage-whereabouts` in the dashboard, which this reuses through
 * the host's `hostNetwork` service rather than doing again):
 *
 * 1. What was found last time, for a few minutes. A sync of a house with ten
 *    devices on one hub asks once, not ten times.
 * 2. The host's neighbour table - which IP answered as which hardware address.
 *    One read serves every device, and it is shared for half a minute.
 * 3. The connection's own way of finding its units, where it has one (a Gree
 *    scan answers with each unit's MAC). This is what works where the table
 *    cannot be read at all: the limited edition has no host daemon.
 * 4. A knock on every address of this server's /24 - one empty datagram each,
 *    which makes the host ask the network who has that address and so fills its
 *    table - then the table again. Bounded (254 datagrams, sent once a minute at
 *    most, whoever asks) and only on a private network.
 *
 * Nothing here dials an address it was not told is the device: the answer is an
 * IP somebody's router handed out, checked against `forbiddenAddress` like a
 * typed one, and the driver it goes to proves the device the way it always did.
 *
 * Server-only.
 */

import { macHex } from "@polaris/core";
import { host } from "@polaris/app-host";
import { createSocket } from "node:dgram";
import { subnetTargets } from "./lan-unit";
import { readFile } from "node:fs/promises";
import { forbiddenAddress } from "./lan-address";

/** IP address -> hardware address, as either side spells it. */
export type NeighbourTable = ReadonlyMap<string, string>;

/** How a connection that can find its own units says where one is, by MAC. */
export type OwnLookup = (mac: string) => Promise<string | null>;

/** What this reaches out to, so tests can stand in for the network. */
export interface LocateNetwork {
    /** The neighbour table: the host's, plus this machine's own where it has one. */
    neighbours(): Promise<NeighbourTable>;
    /** Send one empty datagram to each address, so the host resolves them. */
    knock(addresses: readonly string[]): Promise<void>;
    /** The other addresses on this server's /24. */
    subnet(): Promise<readonly string[]>;
    /** How long the network is given to answer a knock. */
    readonly settleMs: number;
}

/** A found address is trusted for this long before the table is asked again. */
const FOUND_TTL_MS = 10 * 60 * 1000;
/** One table read serves every lookup for this long. */
const TABLE_TTL_MS = 30 * 1000;
/** The subnet is knocked on at most this often, whoever is asking. */
const KNOCK_EVERY_MS = 60 * 1000;
/** A device that could not be found is not looked for again sooner than this:
 *  one that is simply switched off must not cost a sweep on every sync. */
const MISS_TTL_MS = 2 * 60 * 1000;

/** The discard port. Nothing on a home network is expected to listen, and that
 *  is the point: the datagram is only there to make the host ask who has the
 *  address. */
const KNOCK_PORT = 9;

/** `/proc/net/arp`, where this process can read one: a Polaris that runs on the
 *  host's own network sees the LAN there directly. On a Docker bridge it lists
 *  the gateway only, which harms nothing. */
async function ownTable(): Promise<Map<string, string>> {
    const table = new Map<string, string>();
    let text: string;
    try {
        text = await readFile("/proc/net/arp", "utf8");
    } catch {
        return table;
    }
    for (const line of text.split(/\r?\n/).slice(1)) {
        const [address, , flags, hardware] = line.trim().split(/\s+/);
        if (!address || !flags || !hardware) continue;
        // ATF_COM: the kernel has an answer for this one, not a question.
        if ((Number.parseInt(flags, 16) & 0x2) === 0) continue;
        table.set(address, hardware);
    }
    return table;
}

const realNetwork: LocateNetwork = {
    async neighbours() {
        const [hosts, own] = await Promise.all([
            host.hostNetwork.readNeighbourTable().catch(() => new Map<string, string>()),
            ownTable()
        ]);
        return new Map([...own, ...hosts]);
    },
    knock: (addresses) =>
        new Promise((resolve) => {
            const socket = createSocket({ type: "udp4" });
            const payload = Buffer.alloc(0);
            let left = addresses.length;
            const done = () => {
                try {
                    socket.close();
                } catch {
                    // Already closed.
                }
                resolve();
            };
            socket.on("error", done);
            if (left === 0) return done();
            for (const address of addresses) {
                socket.send(payload, KNOCK_PORT, address, () => {
                    left -= 1;
                    if (left === 0) done();
                });
            }
        }),
    subnet: () => subnetTargets(),
    settleMs: 1500
};

let network: LocateNetwork = realNetwork;
const found = new Map<string, { address: string; at: number }>();
const missed = new Map<string, number>();
let table: { at: number; value: Promise<NeighbourTable> } | null = null;
let knocked: { at: number; value: Promise<void> } | null = null;

/** For tests: put a fake network in place (or the real one back), and forget
 *  everything remembered. */
export function useLocateNetwork(next?: LocateNetwork): void {
    network = next ?? realNetwork;
    found.clear();
    missed.clear();
    table = null;
    knocked = null;
}

function readTable(fresh: boolean): Promise<NeighbourTable> {
    const now = Date.now();
    if (!fresh && table && now - table.at < TABLE_TTL_MS) return table.value;
    const value = network.neighbours().catch(() => new Map<string, string>());
    table = { at: now, value };
    return value;
}

/** The addresses a hardware address answers on in a table, the one to avoid
 *  (where it was, and stopped answering) last. */
function inTable(neighbours: NeighbourTable, hex: string, avoid?: string): string | null {
    const hits = [...neighbours]
        .filter(([address, hardware]) => macHex(hardware) === hex && !forbiddenAddress(address))
        .map(([address]) => address)
        .sort((a, b) => Number(a === avoid) - Number(b === avoid));
    return hits[0] ?? null;
}

async function knockOnSubnet(): Promise<void> {
    const now = Date.now();
    if (knocked && now - knocked.at < KNOCK_EVERY_MS) return knocked.value;
    const value = (async () => {
        const addresses = await network.subnet();
        if (addresses.length === 0) return;
        await network.knock(addresses);
        await new Promise((resolve) => setTimeout(resolve, network.settleMs));
    })().catch(() => undefined);
    knocked = { at: now, value };
    return value;
}

export interface LocateOptions {
    /** Look again even when an address is remembered: the one remembered has
     *  just stopped answering. */
    readonly fresh?: boolean;
    /** The address it stopped answering at, tried last. */
    readonly avoid?: string;
    /** The connection's own way of finding a unit by MAC, where it has one. */
    readonly own?: OwnLookup;
}

/**
 * The IP address a MAC answers on now, or null when nothing on this network
 * claims it - a device that is off, or on a network this server cannot see.
 */
export async function locateMac(mac: string, options: LocateOptions = {}): Promise<string | null> {
    const hex = macHex(mac);
    if (!hex) return null;
    const now = Date.now();
    const known = found.get(hex);
    if (!options.fresh && known && now - known.at < FOUND_TTL_MS) return known.address;
    // A fresh look is still not repeated for a device just found missing.
    const missedAt = missed.get(hex);
    if (missedAt !== undefined && now - missedAt < MISS_TTL_MS) return known?.address ?? null;

    const keep = (address: string) => {
        found.set(hex, { address, at: Date.now() });
        missed.delete(hex);
        return address;
    };

    const first = inTable(await readTable(options.fresh === true), hex, options.avoid);
    if (first && first !== options.avoid) return keep(first);

    if (options.own) {
        const own = await options.own(hex).catch(() => null);
        if (own && !forbiddenAddress(own)) return keep(own);
    }

    await knockOnSubnet();
    const second = inTable(await readTable(true), hex, options.avoid);
    if (second) return keep(second);

    missed.set(hex, Date.now());
    return first;
}

/** Forget where a MAC was, after it stopped answering there. */
export function forgetMac(mac: string): void {
    const hex = macHex(mac);
    if (hex) found.delete(hex);
}

/**
 * The hardware address each of these answered as, from a fresh read of the
 * neighbour table - for a scan whose answers carry no MAC of their own. Just
 * having been asked by the scan is what put them in the table.
 */
export async function macsAt(addresses: readonly string[]): Promise<Map<string, string>> {
    const macs = new Map<string, string>();
    if (addresses.length === 0) return macs;
    const neighbours = await readTable(true);
    for (const address of addresses) {
        const hex = macHex(neighbours.get(address));
        if (hex) macs.set(address, hex.toUpperCase().match(/../g)!.join(":"));
    }
    return macs;
}
