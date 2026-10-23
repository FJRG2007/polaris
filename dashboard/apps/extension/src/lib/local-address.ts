/**
 * The pure half of `lib/reach`: what the popup and the worker both need to know
 * about a server's local addresses, with no storage and no network, so the popup
 * can import it without the worker's state.
 */

import type { InstanceRecord } from "@polaris/core/instance-fallback";

/** What the popup draws about the address in use. Flags only: the words are its own. */
export interface ReachStatus {
    /** On an alternate rather than the address the extension was given. */
    readonly local: boolean;
    /** A local address could not be opened because the browser does not trust its certificate. */
    readonly untrusted: boolean;
    /** Hosts that answered as a different Polaris and were sent nothing. */
    readonly refused: readonly string[];
    /** Local addresses the extension may not reach yet, for the popup to ask for. */
    readonly missing: readonly string[];
}

export const NO_REACH: ReachStatus = { local: false, untrusted: false, refused: [], missing: [] };

/** The same host without TLS, or null for an address that is not https. */
export function plainOrigin(origin: string): string | null {
    try {
        const url = new URL(origin);
        return url.protocol === "https:" ? `http://${url.hostname}` : null;
    } catch {
        return null;
    }
}

/**
 * The host permissions a local address needs: the address itself, and the same
 * host without TLS, which is how an untrusted certificate is told apart from an
 * address that is not there.
 */
export function localPermissions(origins: readonly string[]): string[] {
    const patterns = new Set<string>();
    for (const origin of origins) {
        patterns.add(`${origin}/*`);
        const plain = plainOrigin(origin);
        if (plain) patterns.add(`${plain}/*`);
    }
    return [...patterns];
}

/** The addresses other than the usual one. */
export function alternatesOf(record: InstanceRecord, primary: string): string[] {
    return record.addresses.filter((origin) => origin !== primary);
}
