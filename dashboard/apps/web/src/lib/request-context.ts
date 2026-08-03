/**
 * Request-context helpers: who is asking, from where, and under which of this
 * deployment's names. They resolve the client IP (needed for CIDR allowlists),
 * the user-agent and host recorded against a session, and privacy-safe hashes
 * for access logs. The IP is read from the forwarded headers the reverse proxy
 * sets; the trusted-proxy configuration (POLARIS_TRUSTED_PROXIES) governs how far
 * that header is believed, with a safe default of trusting only the bundled
 * proxy.
 */

import { headers } from "next/headers";
import { createHash } from "node:crypto";
import { originHost, originIp, originUserAgent } from "@polaris/core";

/** Best-effort client IP from the forwarded headers, or undefined. */
export async function clientIp(): Promise<string | undefined> {
    return originIp(await headers());
}

/** The client user-agent string, or undefined. */
export async function clientUserAgent(): Promise<string | undefined> {
    return originUserAgent(await headers());
}

/**
 * The name this deployment was reached under, without the port. Polaris answers
 * on several - polaris.local on the LAN, its domain from outside - and which one
 * a request came in on is what tells two otherwise identical sessions apart.
 *
 * Never used to decide anything: the header is client-supplied, so it is only
 * ever a label. The one place a host does drive a decision - which relying party
 * a passkey is bound to - checks it against the trusted list first.
 */
export async function clientHost(): Promise<string | undefined> {
    return originHost(await headers());
}

/** Truncated SHA-256 of a value for logging, or undefined when the input is empty. */
export function hashForLog(value: string | undefined): string | undefined {
    if (!value) return undefined;
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
