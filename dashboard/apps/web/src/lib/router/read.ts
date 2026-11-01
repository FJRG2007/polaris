/**
 * What a machine answers to the router probe, turned into what the screen shows.
 * Pure: a machine's output is untrusted text, so everything here is parsed against a
 * schema and anything unreadable is left out rather than shown wrong.
 */

import { z } from "zod";
import { MAX_CLIENTS } from "./plan";

const linkSchema = z.object({
    ifname: z.string(),
    operstate: z.string().optional(),
    address: z.string().optional(),
    link_type: z.string().optional()
});
const addressSchema = z.object({
    ifname: z.string(),
    addr_info: z
        .array(z.object({ local: z.string(), prefixlen: z.number() }))
        .optional()
        .default([])
});
const routeSchema = z.object({ dev: z.string(), gateway: z.string().optional() });
const countersSchema = z.object({
    ifname: z.string(),
    stats64: z
        .object({ rx: z.object({ bytes: z.number() }), tx: z.object({ bytes: z.number() }) })
        .optional()
});

export interface RouterPort {
    readonly name: string;
    readonly up: boolean;
    readonly mac: string | null;
    readonly addresses: readonly string[];
    /** The machine reaches the internet this way now. */
    readonly hasGateway: boolean;
    readonly received: number;
    readonly sent: number;
}

export interface RouterClient {
    readonly address: string;
    readonly mac: string;
    readonly name: string | null;
    /** When the lease runs out, in seconds since the epoch. */
    readonly expires: number;
}

export interface RouterReading {
    readonly ports: readonly RouterPort[];
    readonly activeWan: string | null;
    readonly running: boolean;
    readonly clients: readonly RouterClient[];
    /** The last change did not stick and the machine went back. */
    readonly rolledBack: boolean;
}

const VIRTUAL = /^(lo|docker\d*|br-|veth|tailscale|wg|virbr|cni|flannel)/;

function jsonList<T>(raw: string, schema: z.ZodType<T>): T[] {
    try {
        const parsed: unknown = JSON.parse(raw || "[]");
        if (!Array.isArray(parsed)) return [];
        return parsed.flatMap((entry) => {
            const read = schema.safeParse(entry);
            return read.success ? [read.data] : [];
        });
    } catch {
        return [];
    }
}

/** The output of `PROBE_SCRIPT`, cut at its `---name` lines. */
function sectionsOf(output: string): Map<string, string> {
    const sections = new Map<string, string>();
    let name: string | null = null;
    let lines: string[] = [];
    for (const line of output.split("\n")) {
        const marker = /^---([a-z]+)$/.exec(line.trim());
        if (marker?.[1]) {
            if (name) sections.set(name, lines.join("\n").trim());
            name = marker[1];
            lines = [];
        } else {
            lines.push(line);
        }
    }
    return sections;
}

/** One dnsmasq lease line: expiry, MAC, address, name, client id. */
function clientOf(line: string): RouterClient | null {
    const [expires, mac, address, name] = line.trim().split(/\s+/);
    if (!expires || !mac || !address) return null;
    const when = Number(expires);
    if (!Number.isFinite(when)) return null;
    return { address, mac, name: name && name !== "*" ? name : null, expires: when };
}

export function readProbe(output: string): RouterReading {
    const sections = sectionsOf(output);
    const section = (name: string) => sections.get(name) ?? "";
    const links = jsonList(section("links"), linkSchema);
    const addresses = jsonList(section("addresses"), addressSchema);
    const routes = jsonList(section("routes"), routeSchema);
    const counters = jsonList(section("counters"), countersSchema);
    const ports = links
        .filter(({ ifname }) => !VIRTUAL.test(ifname))
        .map((link): RouterPort => {
            const stats = counters.find(({ ifname }) => ifname === link.ifname)?.stats64;
            return {
                name: link.ifname.split("@")[0] ?? link.ifname,
                up: link.operstate === "UP" || link.operstate === "UNKNOWN",
                mac: link.address ?? null,
                addresses: (
                    addresses.find(({ ifname }) => ifname === link.ifname)?.addr_info ?? []
                ).map(({ local, prefixlen }) => `${local}/${prefixlen}`),
                hasGateway: routes.some(({ dev, gateway }) => dev === link.ifname && !!gateway),
                received: stats?.rx.bytes ?? 0,
                sent: stats?.tx.bytes ?? 0
            };
        });
    return {
        ports,
        activeWan: section("wan") || null,
        running: section("services")
            .split("\n")
            .filter(Boolean)
            .every((line) => line === "active")
            ? section("services") !== ""
            : false,
        clients: section("leases")
            .split("\n")
            .flatMap((line) => clientOf(line) ?? [])
            .slice(0, MAX_CLIENTS),
        rolledBack: section("last") === "rolled-back"
    };
}
