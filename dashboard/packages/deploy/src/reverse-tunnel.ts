/**
 * Reverse SSH tunnels: publish a service that lives on an unreachable box (carrier
 * NAT, no port-forwarding) through a server the operator already owns. The unreachable
 * box dials out with `ssh -R`, so the public server ends up holding a local port that
 * forwards back to the service, and its Traefik routes a hostname to that port.
 *
 * Nothing here is a third-party tunnel: it is OpenSSH on one side, the operator's own
 * server on the other, and both are already part of Polaris (registered hosts carry
 * their credentials, onboarding puts Traefik on them). Pure - it only builds the port
 * number, the command line and the config text; the caller runs and ships them.
 */

import { shortHash } from "./naming.js";

/**
 * The address the remote forward binds to on the public server: the Docker bridge
 * gateway, which its Traefik container can reach and the internet cannot. Binding
 * anywhere but loopback needs `GatewayPorts clientspecified` in sshd (see
 * `tunnelSetupScript`), and loopback would be unreachable from inside Traefik.
 */
export const TUNNEL_BIND_ADDRESS = "172.17.0.1";

/** Ports the forwards live in - above the deploy range, below the ephemeral one. */
const PORT_BASE = 42000;
const PORT_SPAN = 4000;

/**
 * A stable port on the public server for an app's tunnel, derived from its id so it
 * survives restarts and needs no allocation table. The span is small enough to stay
 * out of the way and large enough that a collision needs hundreds of tunnels.
 */
export function reverseTunnelPort(appId: string): number {
    return PORT_BASE + (parseInt(shortHash(appId, 6), 16) % PORT_SPAN);
}

/** Router/service name for the tunnel's Traefik entry, and its config file name. */
export function reverseTunnelName(appId: string): string {
    return `polaris-tunnel-${shortHash(appId, 8)}`;
}

export interface ReverseTunnelSpec {
    /** The app being published. */
    readonly appId: string;
    /** The hostname the public server should answer for. */
    readonly hostname: string;
    /** Where the service actually listens, on the box running the tunnel client. */
    readonly localHost: string;
    readonly localPort: number;
}

/**
 * The ssh client arguments. Keepalives plus `ExitOnForwardFailure` are what make the
 * tunnel self-healing: if the link dies or the port cannot be bound, ssh exits and the
 * container's restart policy dials again, rather than sitting on a forward that no
 * longer carries traffic. Host-key checking is off because the key is pinned by
 * Polaris when the server is registered, not by this container's known_hosts.
 */
export function reverseTunnelArgv(
    spec: ReverseTunnelSpec,
    server: { host: string; port: number; username: string; keyPath: string }
): string[] {
    return [
        "ssh",
        "-N",
        "-i",
        server.keyPath,
        "-p",
        String(server.port),
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "-R",
        `${TUNNEL_BIND_ADDRESS}:${reverseTunnelPort(spec.appId)}:${spec.localHost}:${spec.localPort}`,
        `${server.username}@${server.host}`
    ];
}

/**
 * The Traefik dynamic configuration that publishes the tunnel: one router for the
 * hostname and one service pointing at the forwarded port on the server's own bridge
 * gateway. Written to the file provider directory the onboarding script watches.
 */
export function reverseTunnelConfig(spec: ReverseTunnelSpec): string {
    const name = reverseTunnelName(spec.appId);
    return [
        "# Managed by Polaris - reverse tunnel. Do not edit.",
        "http:",
        "  routers:",
        `    ${name}:`,
        `      rule: "Host(\`${spec.hostname}\`)"`,
        "      entryPoints:",
        "        - websecure",
        `      service: ${name}`,
        "      tls:",
        "        certResolver: letsencrypt",
        "  services:",
        `    ${name}:`,
        "      loadBalancer:",
        "        servers:",
        `          - url: "http://${TUNNEL_BIND_ADDRESS}:${reverseTunnelPort(spec.appId)}"`,
        ""
    ].join("\n");
}

/**
 * Prepare the public server to terminate tunnels, idempotently: allow a client to
 * bind a forward somewhere other than loopback (Traefik cannot reach loopback from
 * its container), and mint a dedicated key the tunnel client authenticates with, so
 * the operator's own credentials never leave Polaris. Prints the private key on
 * stdout - the caller stores it encrypted.
 */
export function tunnelSetupScript(): string {
    return [
        "set -e",
        "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
        "if [ ! -f ~/.ssh/polaris_tunnel ]; then",
        "  ssh-keygen -t ed25519 -N '' -C polaris-tunnel -f ~/.ssh/polaris_tunnel >/dev/null;",
        "fi",
        "touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys",
        'if ! grep -qF "$(cat ~/.ssh/polaris_tunnel.pub)" ~/.ssh/authorized_keys; then',
        "  cat ~/.ssh/polaris_tunnel.pub >> ~/.ssh/authorized_keys;",
        "fi",
        // A forward bound off loopback is refused unless sshd allows it. Left to the
        // operator when sshd cannot be edited: the tunnel then fails to bind and says so.
        "if ! grep -q '^GatewayPorts clientspecified' /etc/ssh/sshd_config 2>/dev/null; then",
        "  echo 'GatewayPorts clientspecified' | sudo tee -a /etc/ssh/sshd_config >/dev/null 2>&1 || true;",
        "  sudo systemctl reload sshd >/dev/null 2>&1 || sudo systemctl reload ssh >/dev/null 2>&1 || true;",
        "fi",
        "mkdir -p /var/lib/polaris/traefik/dynamic",
        "cat ~/.ssh/polaris_tunnel"
    ].join("\n");
}
