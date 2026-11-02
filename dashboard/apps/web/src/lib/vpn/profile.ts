/**
 * A VPN somebody already pays for: the WireGuard file a provider hands out, read into
 * what the desktop app needs to connect. Pure, so every file shape is asserted.
 *
 * Only the fields that describe the tunnel are read. wg-quick's PreUp and PostUp lines
 * are commands, and nothing here ever runs them.
 */

import { z } from "zod";
import { isIP } from "node:net";
import { isWireGuardKey } from "./wireguard";
import { MAX_PROFILE_BYTES } from "./profile-limits";

const MAX_ADDRESSES = 4;
const MAX_DNS = 4;
const MAX_ALLOWED = 64;
const MIN_MTU = 576;
const MAX_MTU = 9000;

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

function isNetwork(value: string): boolean {
    const [address, prefix, ...rest] = value.split("/");
    const family = isIP(address ?? "");
    if (family === 0 || rest.length > 0) return false;
    if (prefix === undefined) return true;
    return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

const key = z.string().refine(isWireGuardKey);
const network = z.string().max(64).refine(isNetwork);

export const profileSchema = z.object({
    privateKey: key,
    addresses: z.array(network).min(1).max(MAX_ADDRESSES),
    dns: z.array(z.string().refine((value) => isIP(value) !== 0)).max(MAX_DNS),
    mtu: z.number().int().min(MIN_MTU).max(MAX_MTU).nullable(),
    publicKey: key,
    presharedKey: key.nullable(),
    endpoint: z
        .string()
        .min(1)
        .max(255)
        .refine((host) => isIP(host) !== 0 || HOSTNAME.test(host)),
    port: z.number().int().min(1).max(65535),
    allowedIps: z.array(network).min(1).max(MAX_ALLOWED)
});

export type Profile = z.infer<typeof profileSchema>;

function list(value: string | undefined): string[] {
    return (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

/** `host:port`, with an IPv6 host in brackets. */
function splitEndpoint(value: string): { host: string; port: number } | null {
    const match = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d{1,5})$/.exec(value);
    if (!match) return null;
    return { host: (match[1] ?? match[2]) as string, port: Number(match[3]) };
}

/** One section per name; the file is refused if a tunnel has several servers. */
function sections(text: string): Map<string, Map<string, string>[]> {
    const found = new Map<string, Map<string, string>[]>();
    let current: Map<string, string> | null = null;
    for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
        const line = raw.replace(/[#;].*$/, "").trim();
        if (!line) continue;
        const heading = /^\[(\w+)\]$/.exec(line);
        if (heading) {
            const name = (heading[1] as string).toLowerCase();
            current = new Map();
            found.set(name, [...(found.get(name) ?? []), current]);
            continue;
        }
        const at = line.indexOf("=");
        if (current && at > 0) {
            current.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
        }
    }
    return found;
}

/** The tunnel in a file, or null when the file is not one this can connect. */
export function parseProfile(text: string): Profile | null {
    if (text.length > MAX_PROFILE_BYTES) return null;
    const parts = sections(text);
    const [own] = parts.get("interface") ?? [];
    const peers = parts.get("peer") ?? [];
    const [peer] = peers;
    if (!own || !peer || peers.length !== 1) return null;
    const endpoint = splitEndpoint(peer.get("endpoint") ?? "");
    if (!endpoint) return null;
    const mtu = own.get("mtu");
    const parsed = profileSchema.safeParse({
        privateKey: own.get("privatekey"),
        addresses: list(own.get("address")),
        // A provider can list a search domain here; only addresses are servers.
        dns: list(own.get("dns")).filter((value) => isIP(value) !== 0),
        mtu: mtu === undefined ? null : Number(mtu),
        publicKey: peer.get("publickey"),
        presharedKey: peer.get("presharedkey") ?? null,
        endpoint: endpoint.host,
        port: endpoint.port,
        allowedIps: list(peer.get("allowedips"))
    });
    return parsed.success ? parsed.data : null;
}

/** What to call a file's tunnel: its name without the extension. */
export function profileName(fileName: string): string {
    const base = fileName
        .replace(/^.*[\\/]/, "")
        .replace(/\.[^.]*$/, "")
        .trim();
    return base.slice(0, 80) || "VPN";
}
