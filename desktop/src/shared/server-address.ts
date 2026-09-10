/**
 * The address of the Polaris this app opens, as typed on the first run.
 *
 * Shared by the form that asks for it and by the main process that stores it, so
 * the field says the same thing the store would refuse. One stored form: the
 * origin, `https://host[:port]`, lowercased, with the default port dropped and no
 * trailing slash - which is also what the navigation allowlist compares against.
 *
 * Only the address. A path, a query or a user name is refused rather than cut
 * off, because Polaris is always served from the root of its host and a pasted
 * `https://polaris.example.com/home` is better answered with the address to use
 * than silently rewritten.
 */

import { z } from "zod";

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Names that only resolve inside a network: mDNS, common router suffixes, and
 *  the ones reserved for private use. */
const OWN_NETWORK_SUFFIXES = [".local", ".lan", ".home.arpa", ".internal", ".localhost"];

function isPrivateIpv4(host: string): boolean {
    const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)?.slice(1).map(Number);
    if (!parts) return false;
    const [a = -1, b = -1] = parts;
    return (
        a === 10 ||
        a === 127 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254) ||
        (a === 100 && b >= 64 && b <= 127)
    );
}

function isPrivateIpv6(host: string): boolean {
    const address = host.replace(/^\[|\]$/g, "");
    return address === "::1" || /^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address);
}

/**
 * Whether a host, as `URL` normalizes it, can only be reached from the network
 * this computer is on: loopback, the private and shared (CGNAT, which is where
 * Tailscale lives) IPv4 ranges, link-local, IPv6 unique-local, a name with no
 * dot, or a name under a suffix no public DNS answers for.
 */
export function isOwnNetworkHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/\.$/, "");
    if (host.startsWith("[")) return isPrivateIpv6(host);
    if (/^[\d.]+$/.test(host)) return isPrivateIpv4(host);
    return !host.includes(".") || OWN_NETWORK_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * The text as it should be read: trimmed, and taken as https when no scheme was
 * typed. The schema below still decides whether the result is an address.
 */
export function normalizeServerInput(raw: string): string {
    const text = raw.trim();
    if (!text) return text;
    return SCHEME.test(text) ? text : `https://${text}`;
}

/** The address, or the sentence saying what is wrong with it. */
export const serverAddressSchema = z
    .string()
    .transform(normalizeServerInput)
    .transform((text, ctx) => {
        if (!text) {
            ctx.addIssue({ code: "custom", message: "Enter the address of your Polaris." });
            return z.NEVER;
        }
        let url: URL;
        try {
            url = new URL(text);
        } catch {
            ctx.addIssue({ code: "custom", message: "That is not an address. It looks like https://polaris.example.com." });
            return z.NEVER;
        }
        if (url.protocol !== "https:" && url.protocol !== "http:") {
            ctx.addIssue({ code: "custom", message: "The address starts with https:// (or http:// on your own network)." });
            return z.NEVER;
        }
        if (!url.hostname || /\s/.test(text)) {
            ctx.addIssue({ code: "custom", message: "That is not an address. It looks like https://polaris.example.com." });
            return z.NEVER;
        }
        if (url.protocol === "http:" && !isOwnNetworkHost(url.hostname)) {
            ctx.addIssue({
                code: "custom",
                message: "An address on the internet needs https://. http:// works only on your own network."
            });
            return z.NEVER;
        }
        if (url.username || url.password) {
            ctx.addIssue({ code: "custom", message: "Leave the user name and password out of the address." });
            return z.NEVER;
        }
        if (url.pathname !== "/" || url.search || url.hash) {
            ctx.addIssue({ code: "custom", message: `Only the address, without a path: ${url.origin}` });
            return z.NEVER;
        }
        return url.origin;
    });

export type ServerAddress = z.output<typeof serverAddressSchema>;

/** The stored address, or null when what was stored is no longer one. */
export function readServerAddress(value: unknown): string | null {
    const parsed = serverAddressSchema.safeParse(typeof value === "string" ? value : "");
    return parsed.success ? parsed.data : null;
}
