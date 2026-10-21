/**
 * The parts of the connector rules the browser reads as well: who an
 * administrator lets connect, and which hosts. Nothing here may import a
 * server module - the admin card is a client component.
 */

export const CONNECTOR_AUDIENCES = ["everyone", "admins", "off"] as const;
export type ConnectorAudience = (typeof CONNECTOR_AUDIENCES)[number];

export interface ConnectorPolicyValue {
    who: ConnectorAudience;
    hosts: string[];
    privateNetwork: boolean;
}

export const DEFAULT_CONNECTOR_POLICY: ConnectorPolicyValue = {
    who: "everyone",
    hosts: [],
    privateNetwork: false
};

/** A host as an allowlist entry: lowercase, no scheme, port or path. */
export function normalizeHostEntry(raw: string): string | null {
    const trimmed = raw.trim().toLowerCase().replace(/^\*\./, "");
    if (!trimmed) return null;
    try {
        const host = new URL(`https://${trimmed}`).hostname;
        return host && !host.includes("/") ? host : null;
    } catch {
        return null;
    }
}

/**
 * Whether the deployment lets anybody connect this address. An empty list
 * allows every host; an entry allows itself and every name under it.
 */
export function hostAllowed(url: string, allowlist: readonly string[]): boolean {
    if (allowlist.length === 0) return true;
    let host: string;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return false;
    }
    return allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`));
}
