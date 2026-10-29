/**
 * The control server's configuration, rendered from what Polaris knows. Pure:
 * the same input always gives the same file, so a test asserts it and a deploy
 * can tell whether the running server already has it.
 *
 * Keys are Headscale v0.29.6's (config-example.yaml of that tag).
 */

import { VPN_PORT } from "./settings";

export interface VpnRenderInput {
    /** The hostname the clients are told to reach, with no scheme. */
    readonly hostname: string;
    readonly baseDomain: string;
    /** The resolvers every device asks, in order. */
    readonly nameservers: readonly string[];
}

/** Public resolvers for a tailnet with no Network filter to ask. */
export const PUBLIC_NAMESERVERS = ["1.1.1.1", "1.0.0.1", "2606:4700:4700::1111"] as const;

function quoted(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function renderHeadscaleConfig(input: VpnRenderInput): string {
    const nameservers = input.nameservers.length > 0 ? input.nameservers : PUBLIC_NAMESERVERS;
    return [
        `server_url: ${quoted(`https://${input.hostname}`)}`,
        // Every interface of the container: the edge reaches it by the host
        // port it is published on, and terminates TLS in front of it.
        `listen_addr: "0.0.0.0:${VPN_PORT}"`,
        `metrics_listen_addr: "127.0.0.1:9090"`,
        `grpc_listen_addr: "127.0.0.1:50443"`,
        "grpc_allow_insecure: false",
        "noise:",
        "  private_key_path: /var/lib/headscale/noise_private.key",
        "prefixes:",
        "  v4: 100.64.0.0/10",
        "  v6: fd7a:115c:a1e0::/48",
        "  allocation: sequential",
        // Tailscale's own relays: a house does not run one, and devices that
        // cannot reach each other directly still connect through these.
        "derp:",
        "  server:",
        "    enabled: false",
        "  urls:",
        "    - https://controlplane.tailscale.com/derpmap/default",
        "  paths: []",
        "  auto_update_enabled: true",
        "  update_frequency: 3h",
        "disable_check_updates: true",
        "node:",
        "  expiry: 0",
        "  ephemeral:",
        "    inactivity_timeout: 30m",
        "database:",
        "  type: sqlite",
        "  sqlite:",
        "    path: /var/lib/headscale/db.sqlite",
        "    write_ahead_log: true",
        // TLS is the edge's; the server never asks for a certificate itself.
        `tls_letsencrypt_hostname: ""`,
        `tls_cert_path: ""`,
        `tls_key_path: ""`,
        "log:",
        "  level: info",
        "  format: text",
        // Kept in the database so Polaris can change it through the API, with
        // no file to write into the container.
        "policy:",
        "  mode: database",
        "dns:",
        "  magic_dns: true",
        `  base_domain: ${quoted(input.baseDomain)}`,
        "  override_local_dns: true",
        "  nameservers:",
        "    global:",
        ...nameservers.map((server) => `      - ${quoted(server)}`),
        "    split: {}",
        "  search_domains: []",
        "  extra_records: []",
        "unix_socket: /var/run/headscale/headscale.sock",
        `unix_socket_permission: "0770"`,
        "logtail:",
        "  enabled: false",
        ""
    ].join("\n");
}

/** The configuration as the one environment value it travels in. */
export function encodeHeadscaleConfig(input: VpnRenderInput): string {
    return Buffer.from(renderHeadscaleConfig(input), "utf8").toString("base64");
}
