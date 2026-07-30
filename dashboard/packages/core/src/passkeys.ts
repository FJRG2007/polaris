/**
 * WebAuthn relying-party rules. Pure and client-safe, so the server that issues a
 * challenge and the browser that decides whether to offer one answer the question
 * the same way.
 *
 * A passkey is bound to one registrable domain - its relying-party id - and a
 * self-hosted Polaris is reached under several names: a public domain, the LAN
 * name, sometimes a bare IP. Which name is in hand decides both whether a passkey
 * can exist there at all and which of the account's passkeys will work.
 */

/** An address that is only a number is not a domain, and no browser accepts one
 *  as a relying party. */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Labels of letters, digits and inner hyphens. A single label is valid on its
 *  own - `localhost` and a bare LAN name have no dot in them. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * The relying-party id for an address, or null when that address cannot hold a
 * passkey. Tolerant of what a caller has in hand - a full URL, a Host header, a
 * `location.hostname` - since the port and the scheme are not part of the id.
 */
export function passkeyRelyingPartyId(address: string | null | undefined): string | null {
    if (!address) return null;
    const host = address
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
        .replace(/[/?#].*$/, "")
        // An IPv6 literal arrives bracketed, and is an address rather than a name.
        .replace(/^\[.*$/, "")
        .replace(/:\d+$/, "")
        .replace(/\.$/, "");
    if (!host || IPV4.test(host) || !HOSTNAME.test(host)) return null;
    return host;
}
