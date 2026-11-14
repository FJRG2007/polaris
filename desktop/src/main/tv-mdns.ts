/**
 * Finding TVs by what they announce on the network (multicast DNS, RFC 6762 and
 * DNS-SD, RFC 6763), with Node's own UDP socket and no dependency.
 *
 * A TV whose debugging only opens through Wireless debugging pairing (Chromecast
 * with Google TV, Google TV Streamer) never answers on the classic port 5555, so
 * the port sweep cannot see it; it does announce `_adb-tls-pairing._tcp` and
 * `_adb-tls-connect._tcp`, and its Cast record names the model (`md`). What is
 * found here feeds the path engine (`tv-path.ts`) as a `TvSighting`.
 *
 * Searching never listens for the network: the query goes out from a port the
 * system picks on each interface's own address and asks for unicast answers, so
 * nothing binds 5353 or joins the multicast group and Windows Defender Firewall
 * has no reason to ask the operator to let Polaris in.
 *
 * The packet reading and the record collecting are pure, so they are tested on
 * packets without a network.
 */

import { networkInterfaces } from "node:os";
import { readTvAddress } from "@/shared/tv-address";
import { createSocket, type Socket } from "node:dgram";
import type { TvService, TvSighting } from "./tv-path";

const MDNS_GROUP = "224.0.0.251";
const MDNS_PORT = 5353;
const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;
const CLASS_IN = 1;
/** The question's top class bit: answer by unicast, so a socket off port 5353 hears it (RFC 6762 5.4). */
const UNICAST_RESPONSE = 0x8000;
/** How often the query goes out while a search listens: under the firewall's 3-second window for unicast answers. */
export const RESEND_MS = 1_000;
/** Compression pointers followed per name before it counts as a loop. */
const MAX_JUMPS = 32;

/** The DNS-SD service type each `TvService` is announced under. */
export const TV_SERVICE_TYPES: Readonly<Record<TvService, string>> = {
    adb: "_adb._tcp.local",
    "adb-tls-connect": "_adb-tls-connect._tcp.local",
    "adb-tls-pairing": "_adb-tls-pairing._tcp.local",
    googlecast: "_googlecast._tcp.local"
};

export interface MdnsRecord {
    readonly name: string;
    readonly type: number;
    /** PTR: the instance name. SRV: the target host. A: the address. TXT: each `key=value`. */
    readonly data: string | readonly string[];
    /** SRV: the service's port. */
    readonly port?: number;
}

/** A TV found by its announcements, with the name it gave itself when it gave one. */
export interface TvAnnouncement extends TvSighting {
    readonly name: string | null;
    /** The port each service announced: Wireless debugging's TLS and pairing ports move on every switch-on. */
    readonly ports: Partial<Record<TvService, number>>;
}

/** A packet as it arrived, with the address it came from. */
export interface MdnsPacket {
    readonly data: Buffer;
    readonly from: string;
}

function encodeName(name: string): Buffer {
    const labels = name.split(".").filter(Boolean).map((label) => {
        const bytes = Buffer.from(label, "utf8");
        return Buffer.concat([Buffer.from([bytes.length]), bytes]);
    });
    return Buffer.concat([...labels, Buffer.from([0])]);
}

/** One query asking for every TV service at once. */
export function tvQuery(): Buffer {
    const header = Buffer.alloc(12);
    const types = Object.values(TV_SERVICE_TYPES);
    header.writeUInt16BE(types.length, 4);
    const questions = types.map((type) => {
        const tail = Buffer.alloc(4);
        tail.writeUInt16BE(TYPE_PTR, 0);
        tail.writeUInt16BE(CLASS_IN | UNICAST_RESPONSE, 2);
        return Buffer.concat([encodeName(type), tail]);
    });
    return Buffer.concat([header, ...questions]);
}

/** A name at `offset`, following compression pointers; `end` is where the name itself stops. */
function readName(packet: Buffer, offset: number): { name: string; end: number; } {
    const labels: string[] = [];
    let at = offset;
    let end = -1;
    for (let jumps = 0; ; ) {
        const length = packet.readUInt8(at);
        if (length === 0) {
            if (end === -1) end = at + 1;
            break;
        }
        if ((length & 0xc0) === 0xc0) {
            jumps += 1;
            if (jumps > MAX_JUMPS) throw new Error("mdns: name loop");
            if (end === -1) end = at + 2;
            at = packet.readUInt16BE(at) & 0x3fff;
            continue;
        }
        if (at + 1 + length > packet.length) throw new Error("mdns: name past the end");
        labels.push(packet.toString("utf8", at + 1, at + 1 + length));
        at += 1 + length;
    }
    return { name: labels.join("."), end };
}

function readTxt(rdata: Buffer): string[] {
    const entries: string[] = [];
    for (let at = 0; at < rdata.length; ) {
        const length = rdata.readUInt8(at);
        if (length > 0) entries.push(rdata.toString("utf8", at + 1, Math.min(rdata.length, at + 1 + length)));
        at += 1 + length;
    }
    return entries;
}

/** The answer and additional records of a response; a malformed packet reads as none. */
export function parseMdns(packet: Buffer): MdnsRecord[] {
    try {
        if (packet.length < 12 || (packet.readUInt16BE(2) & 0x8000) === 0) return [];
        const questions = packet.readUInt16BE(4);
        const count = packet.readUInt16BE(6) + packet.readUInt16BE(8) + packet.readUInt16BE(10);
        let at = 12;
        for (let index = 0; index < questions; index += 1) at = readName(packet, at).end + 4;
        const records: MdnsRecord[] = [];
        for (let index = 0; index < count; index += 1) {
            const { name, end } = readName(packet, at);
            const type = packet.readUInt16BE(end);
            const length = packet.readUInt16BE(end + 8);
            const start = end + 10;
            if (start + length > packet.length) break;
            const rdata = packet.subarray(start, start + length);
            if (type === TYPE_PTR) records.push({ name, type, data: readName(packet, start).name });
            else if (type === TYPE_SRV && length >= 6) {
                records.push({ name, type, data: readName(packet, start + 6).name, port: rdata.readUInt16BE(4) });
            }
            else if (type === TYPE_A && length === 4) records.push({ name, type, data: [...rdata].join(".") });
            else if (type === TYPE_TXT) records.push({ name, type, data: readTxt(rdata) });
            at = start + length;
        }
        return records;
    } catch {
        return [];
    }
}

/** A TXT record's value for `key`, as DNS-SD reads keys: without regard to case. */
function txtValue(entries: readonly string[], key: string): string | null {
    for (const entry of entries) {
        const split = entry.indexOf("=");
        if (split > 0 && entry.slice(0, split).toLowerCase() === key) return entry.slice(split + 1).trim() || null;
    }
    return null;
}

/** Every TV the packets announce, by its address. Names are matched without regard to case, as DNS does. */
export function collectTvs(packets: readonly MdnsPacket[]): Map<string, TvAnnouncement> {
    const instances = new Map<string, { service: TvService; from: string; }>();
    const targets = new Map<string, string>();
    const ports = new Map<string, number>();
    const addresses = new Map<string, string>();
    const texts = new Map<string, readonly string[]>();
    const byType = new Map(Object.entries(TV_SERVICE_TYPES).map(([service, type]) => [type, service as TvService]));
    for (const packet of packets) {
        for (const record of parseMdns(packet.data)) {
            const name = record.name.toLowerCase();
            if (record.type === TYPE_PTR && typeof record.data === "string") {
                const service = byType.get(name);
                if (service) instances.set(record.data.toLowerCase(), { service, from: packet.from });
            } else if (record.type === TYPE_SRV && typeof record.data === "string") {
                targets.set(name, record.data.toLowerCase());
                if (record.port) ports.set(name, record.port);
            }
            else if (record.type === TYPE_A && typeof record.data === "string") addresses.set(name, record.data);
            else if (record.type === TYPE_TXT && Array.isArray(record.data)) texts.set(name, record.data);
        }
    }
    const found = new Map<
        string,
        { services: Set<TvService>; castModel: string | null; name: string | null; ports: Partial<Record<TvService, number>>; }
    >();
    for (const [instance, { service, from }] of instances) {
        const target = targets.get(instance);
        // The host's own address record when it sent one, else the address the answer came from.
        const address = readTvAddress((target && addresses.get(target)) ?? from);
        if (!address) continue;
        const entry = found.get(address) ?? { services: new Set<TvService>(), castModel: null, name: null, ports: {} };
        entry.services.add(service);
        const port = ports.get(instance);
        if (port) entry.ports[service] = port;
        const txt = texts.get(instance) ?? [];
        if (service === "googlecast") {
            entry.castModel = txtValue(txt, "md") ?? entry.castModel;
            entry.name = txtValue(txt, "fn") ?? entry.name;
        }
        found.set(address, entry);
    }
    return new Map(
        [...found].map(([address, entry]) => [
            address,
            { services: [...entry.services].sort(), castModel: entry.castModel, name: entry.name ?? entry.castModel, ports: entry.ports }
        ])
    );
}

/** Every TV found, by address: the port sweep's and the announced, one entry per address. */
export function mergeFound(open: readonly string[], heard: ReadonlyMap<string, TvAnnouncement>): string[] {
    const byNumber = (host: string) => host.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
    return [...new Set([...open, ...heard.keys()])].sort((left, right) => byNumber(left) - byNumber(right));
}

/** The names TVs gave themselves, for the addresses that gave one. */
export function namesOf(heard: ReadonlyMap<string, TvAnnouncement>): Record<string, string> {
    return Object.fromEntries([...heard].flatMap(([host, tv]) => (tv.name ? [[host, tv.name]] : [])));
}

/** What is known about a TV before connecting: what it announced, and whether the classic port answered. */
export function sightingOf(heard: TvAnnouncement | undefined, adbOpen: boolean): TvSighting {
    return { services: heard?.services ?? [], castModel: heard?.castModel ?? null, adbOpen };
}

/** This computer's private IPv4 addresses, one per interface the query goes out on. */
function localAddresses(): string[] {
    return Object.values(networkInterfaces())
        .flatMap((list) => list ?? [])
        .filter((entry) => entry.family === "IPv4" && !entry.internal && readTvAddress(entry.address))
        .map((entry) => entry.address);
}

/**
 * When the query goes out, in ms from the start: every `RESEND_MS` for as long as
 * the search listens. Windows Defender Firewall lets unicast answers to a multicast
 * through for 3 seconds after it was sent, so a gap under that keeps every moment
 * of the listen covered without any inbound rule.
 */
export function askTimes(listenMs: number): number[] {
    const times = [0];
    while (times[times.length - 1]! + RESEND_MS < listenMs) times.push(times[times.length - 1]! + RESEND_MS);
    return times;
}

/** What `browseWith` needs from the system, so the binding and the cadence are tested without a network. */
export interface BrowseDeps {
    readonly locals: () => readonly string[];
    readonly createSocket: (type: "udp4") => Socket;
}

const SYSTEM: BrowseDeps = { locals: localAddresses, createSocket: (type) => createSocket(type) };

/**
 * A socket on one interface's own address and a port the system picks. Never port
 * 5353 and never the wildcard address, and no multicast group joined: that is what
 * a program listening for the network looks like, and what makes Windows ask to
 * let it through the firewall.
 */
function openSocket(local: string, create: BrowseDeps["createSocket"]): Promise<Socket | null> {
    return new Promise((resolve) => {
        const socket = create("udp4");
        socket.once("error", () => {
            socket.close();
            resolve(null);
        });
        socket.bind({ address: local, port: 0 }, () => {
            socket.removeAllListeners("error");
            socket.on("error", () => undefined);
            resolve(socket);
        });
    });
}

/**
 * Asks the network for TVs for `listenMs` and returns what answered. The query
 * goes out on each interface from that interface's own address and a port other
 * than 5353, with the unicast-response bit set: a responder answers such a query
 * by unicast straight back to that port (RFC 6762 5.1, 5.4 and 6.7), which the
 * firewall lets in as the answer to what was sent. Never throws: a network that
 * cannot be asked finds nothing.
 */
export async function browseWith(
    deps: BrowseDeps,
    listenMs: number,
    cancelled: () => boolean = () => false
): Promise<Map<string, TvAnnouncement>> {
    const sockets = (await Promise.all(deps.locals().map(async (local) => ({ local, socket: await openSocket(local, deps.createSocket) }))))
        .flatMap(({ local, socket }) => (socket ? [{ local, socket }] : []));
    if (sockets.length === 0) return new Map();
    const packets: MdnsPacket[] = [];
    const query = tvQuery();
    for (const { local, socket } of sockets) {
        socket.on("message", (data, remote) => packets.push({ data, from: remote.address }));
        try {
            socket.setMulticastInterface(local);
        } catch {
            // The address is bound, so the system's default route for the group still works.
        }
    }
    const ask = () => {
        for (const { socket } of sockets) {
            try {
                socket.send(query, MDNS_PORT, MDNS_GROUP);
            } catch {
                // An interface that went away meanwhile.
            }
        }
    };
    const timers = askTimes(listenMs).map((at) => setTimeout(ask, at));
    const step = 100;
    for (let waited = 0; waited < listenMs && !cancelled(); waited += step) {
        await new Promise((resolve) => setTimeout(resolve, step));
    }
    for (const timer of timers) clearTimeout(timer);
    for (const { socket } of sockets) socket.close();
    return collectTvs(packets);
}

/** `browseWith` on this computer's own interfaces. */
export function browseTvs(listenMs: number, cancelled: () => boolean = () => false): Promise<Map<string, TvAnnouncement>> {
    return browseWith(SYSTEM, listenMs, cancelled);
}
