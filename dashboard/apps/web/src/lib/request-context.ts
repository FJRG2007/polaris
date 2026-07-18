/**
 * Request-context helpers for the public share and file-request paths. These
 * resolve the client IP (needed for CIDR allowlists) and produce privacy-safe
 * hashes for access logs. The IP is read from the forwarded headers the reverse
 * proxy sets; the trusted-proxy configuration (POLARIS_TRUSTED_PROXIES) governs
 * how far that header is believed, with a safe default of trusting only the
 * bundled proxy.
 */

import { createHash } from "node:crypto";
import { headers } from "next/headers";

/** Best-effort client IP from the forwarded headers, or undefined. */
export async function clientIp(): Promise<string | undefined> {
    const store = await headers();
    const forwarded = store.get("x-forwarded-for")?.split(",")[0]?.trim();
    return forwarded || store.get("x-real-ip")?.trim() || undefined;
}

/** The client user-agent string, or undefined. */
export async function clientUserAgent(): Promise<string | undefined> {
    const store = await headers();
    return store.get("user-agent")?.trim() || undefined;
}

/** Truncated SHA-256 of a value for logging, or undefined when the input is empty. */
export function hashForLog(value: string | undefined): string | undefined {
    if (!value) return undefined;
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
