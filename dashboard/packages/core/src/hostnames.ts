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
