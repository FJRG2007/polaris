/**
 * The private addresses a person lets their computer look for model servers
 * on (`local-models`). Shared by the screen and the action, and checked again
 * by the runner itself: Polaris never names an address the runner did not
 * agree to. IP literals only, since a name can resolve anywhere.
 */

import { z } from "zod";

export const LAN_HOSTS_MAX = 8;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The one stored form of an address: trimmed, lower case, brackets dropped. Pure. */
export function normalizeLanHost(value: string): string {
    return value.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

/** Whether an address is in a private, link-local or unique-local range. Pure. */
export function isPrivateLanHost(value: string): boolean {
    const host = normalizeLanHost(value);
    const v4 = IPV4.exec(host);
    if (v4) {
        const parts = v4.slice(1).map(Number);
        if (parts.some((part) => part > 255)) return false;
        const [a, b] = parts as [number, number];
        return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
    }
    if (!host.includes(":") || !/^[0-9a-f:]+$/.test(host)) return false;
    return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
}

export const lanHostSchema = z
    .string()
    .max(80)
    .transform(normalizeLanHost)
    .refine(isPrivateLanHost, { message: "private" });

export const lanHostsSchema = z
    .array(lanHostSchema)
    .max(LAN_HOSTS_MAX)
    .transform((hosts) => [...new Set(hosts)]);
