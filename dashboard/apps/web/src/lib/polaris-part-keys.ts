/**
 * The catalog key of each part of Polaris, by the English name `polaris-parts`
 * gives it. Apart from that module because the footprint card draws it in the
 * browser, and the classification reads server-only modules.
 */

/** Each part by the English name `PARTS` gives it, as its key in the catalog
 *  (`components.footprint.parts.<key>`), so a screen can say it in the reader's
 *  words. Keyed by that name rather than the compose service so a reading
 *  already on its way keeps meaning the same row. */
const PART_CATALOG_KEYS: Readonly<Record<string, string>> = {
    Dashboard: "web",
    Database: "postgres",
    Edge: "traefik",
    "Edge guard": "edgeGuard",
    "Host daemon": "hostd",
    "Call server": "livekit",
    "Local discovery": "mdns",
    "Minecraft router": "mcRouter",
    "Edge (legacy)": "caddy",
    "Public tunnel": "tunnel",
    "Remote access": "tailscale",
    "VPN gateway": "vpnGateway",
    "Relay ports": "relayPorts",
    "Relay link": "relayLink",
    "Backup access": "backupTunnel"
};

/** A part's catalog key, or null for a part the catalog does not know. */
export function partCatalogKey(label: string): string | null {
    return PART_CATALOG_KEYS[label] ?? null;
}

/** The compose projects Polaris starts beside its own stack, by name; plain
 *  strings so a browser module can read them without the classification. */
export const TUNNEL_PROJECT = "polaris-tunnel";
export const PUBLIC_TUNNEL_PROJECT = "polaris-ptunnel";
/** Remote access through Tailscale, started only while it is turned on. */
export const TAILSCALE_PROJECT = "polaris-tailscale";
/** A server's way into the VPN's private networks, started with the first one. */
export const GATEWAY_PROJECT = "polaris-network-gateway";
/** The backup way in, started while backup access is on. */
export const BACKUP_TUNNEL_PROJECT = "polaris-backup-tunnel";
/** What an agent session's container and compose project are named after: the
 *  session id follows. */
export const SESSION_CONTAINER_PREFIX = "polaris-session-";
