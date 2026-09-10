/**
 * Who answers a DNS-01 challenge: whatever can write a TXT record into the zone.
 *
 * A seam rather than calls straight into one DNS host, because the order does not
 * care where the zone lives - only that an answer can be published at a name and
 * taken away again. Cloudflare is the one implemented, since it is the DNS host
 * Polaris already holds a token for; another is one more entry here, not a change
 * to the order.
 */

import { createTxtRecord, deleteDnsRecord, resolveZoneForHostname } from "@/lib/integrations/cloudflare-api";

export const DNS01_PROVIDERS = ["cloudflare"] as const;
export type Dns01ProviderKind = (typeof DNS01_PROVIDERS)[number];

export interface Dns01Provider {
    readonly kind: Dns01ProviderKind;
    /** Publish one answer at `name`, beside any already there, and return what
     *  removes exactly that one. */
    present(name: string, value: string): Promise<string>;
    /** Remove one answer `present` published. */
    cleanup(handle: string): Promise<void>;
}

/** The provider for a domain whose zone a Cloudflare token can write. Throws the
 *  sentence to show when the token does not reach that zone. */
export async function cloudflareDns01(token: string, domain: string): Promise<Dns01Provider> {
    const zone = await resolveZoneForHostname(token, domain);
    return {
        kind: "cloudflare",
        present: (name, value) => createTxtRecord(token, zone.id, name, value),
        cleanup: (handle) => deleteDnsRecord(token, zone.id, handle)
    };
}

/** The provider of a given kind for a domain, with the credential it takes. */
export function dns01Provider(kind: Dns01ProviderKind, credential: string, domain: string): Promise<Dns01Provider> {
    switch (kind) {
        case "cloudflare":
            return cloudflareDns01(credential, domain);
    }
}
