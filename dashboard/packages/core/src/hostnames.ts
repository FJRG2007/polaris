/**
 * Hostname classification shared across Deploy. A "tunnel-managed" hostname is one a
 * tunnel provider owns and rotates (Cloudflare quick tunnels, ngrok) or Polaris's
 * own internal edge-routing host. None of these is a real domain a user should add
 * under "Add a domain": the tunnel already exposes the app, so adding it as a domain
 * only creates an inert route (inbound traffic reaches the tunnel provider, not the
 * local edge) and, with Let's Encrypt, a failing ACME loop. Pure and client-safe.
 */

/** Suffixes owned by a tunnel provider, or Polaris's internal quick-tunnel edge host. */
const TUNNEL_SUFFIXES = [
    ".trycloudflare.com",
    ".ngrok.io",
    ".ngrok-free.app",
    ".ngrok.app",
    ".ngrok.dev",
    ".qtunnel.polaris"
] as const;

/**
 * True if the hostname is exposed/rotated by a tunnel and so must not be added as a
 * domain. Case-insensitive and tolerant of a scheme, port, or path a user might paste
 * along with the host.
 */
export function isTunnelHostname(hostname: string): boolean {
    const host = hostname
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "")
        .replace(/:\d+$/, "");
    return TUNNEL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/* -------------------------------------------------------------------------- */
/* Typed domain fields                                                         */
/* -------------------------------------------------------------------------- */

/** One DNS label: letters, digits and inner dashes, 63 at most (RFC 1035). */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A typed host as Polaris compares it: lower case, without the scheme, path, port or
 * trailing dot someone pastes along with it. One normalizer for the page and the
 * server, so the check the field shows is the check the save makes.
 */
export function normalizeHostInput(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
        .replace(/[/?#].*$/, "")
        .replace(/:\d+$/, "")
        .replace(/\.+$/, "");
}

/** Whether `value` is one DNS label (`plr`, `my-box`). */
export function isDnsLabel(value: string): boolean {
    return DNS_LABEL.test(value);
}

/** Whether `value` is a domain name of two or more labels (`example.com`), as given:
 *  no scheme, wildcard, port or path. The last label is never all digits - no top
 *  level domain is - so a mistyped address like `999.1.1.1` is not a name either. */
export function isDomainName(value: string): boolean {
    if (value.length === 0 || value.length > 253) return false;
    const labels = value.split(".");
    if (labels.length < 2 || !labels.every((label) => DNS_LABEL.test(label))) return false;
    return !/^\d+$/.test(labels[labels.length - 1] ?? "");
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * A site address as the app and sharing domains store it, or null when it is not
 * one: a domain name, an IPv4 address or `localhost`, optionally with `http://` or
 * `https://`, a port and a trailing slash. `https://` and the trailing slash are
 * dropped, since an address without a scheme already means https; `http://` and a
 * port are kept, because a LAN install reached on one would lose its way in without
 * them. Anything else - a path, spaces, `////` - is not an address.
 */
export function normalizeSiteAddress(value: string): string | null {
    const typed = value.trim().toLowerCase().replace(/\/+$/, "");
    const match = /^(?:(https?):\/\/)?([^/:?#\s]+)(?::(\d{1,5}))?$/.exec(typed);
    if (!match) return null;
    const [, scheme, host = "", port] = match;
    const bare = host.replace(/\.$/, "");
    if (!(isDomainName(bare) || IPV4.test(bare) || bare === "localhost")) return null;
    if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
    const address = port ? `${bare}:${port}` : bare;
    return scheme === "http" ? `http://${address}` : address;
}
