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
 * The address the remote forward binds to when the public server does not say what
 * its Docker bridge gateway is: the stock docker0 address, which its Traefik container
 * can reach and the internet cannot. `tunnelSetupScript` asks the server for the real
 * one, since a custom `bip`, rootless Docker or Podman puts it elsewhere. Binding
 * anywhere but loopback needs `GatewayPorts clientspecified` in sshd, and loopback
 * would be unreachable from inside Traefik.
 */
export const DEFAULT_TUNNEL_BIND_ADDRESS = "172.17.0.1";

/**
 * Options the tunnel key is authorized with. It exists to hold one reverse forward
 * open, so `restrict` drops everything else the key would otherwise grant on the
 * operator's own server - shell, sftp, pty, agent and X11 forwarding - and only port
 * forwarding is handed back.
 */
const KEY_OPTIONS = "restrict,port-forwarding";

/** Ports the forwards live in - above the deploy range, below the ephemeral one. */
const PORT_BASE = 42000;
const PORT_SPAN = 4000;

/**
 * A port on the public server for an app's tunnel: derived from the app id, so the
 * same app keeps the same port, and probed forward from there past ports already
 * handed out on that server. Both ends bake the port in - the forward and the route -
 * so two apps sharing one would leave the second's hostname serving the first's
 * service; the caller passes what it has allocated and persists the answer.
 */
export function reverseTunnelPort(appId: string, taken: readonly number[] = []): number {
    const start = parseInt(shortHash(appId, 6), 16) % PORT_SPAN;
    const used = new Set(taken);
    for (let step = 0; step < PORT_SPAN; step += 1) {
        const port = PORT_BASE + ((start + step) % PORT_SPAN);
        if (!used.has(port)) return port;
    }
    throw new Error("That server has no free tunnel port left");
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
    /** The port allocated to this app's forward on the public server. */
    readonly remotePort: number;
    /** The address the forward binds to there, as the server reported it. */
    readonly bindAddress: string;
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
        `${spec.bindAddress}:${spec.remotePort}:${spec.localHost}:${spec.localPort}`,
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
        `          - url: "http://${spec.bindAddress}:${spec.remotePort}"`,
        ""
    ].join("\n");
}

/** The docker template that prints a network's gateway, tried on two networks. */
const GATEWAY_FORMAT = "'{{(index .IPAM.Config 0).Gateway}}'";

/**
 * Prepare the public server to terminate tunnels, idempotently: allow a client to
 * bind a forward somewhere other than loopback (Traefik cannot reach loopback from
 * its container), mint a dedicated key the tunnel client authenticates with, so the
 * operator's own credentials never leave Polaris, and report where the forward has
 * to bind. Prints `polaris-bind=<address>` and the private key on stdout - see
 * `parseTunnelSetup`; the caller stores the key encrypted.
 *
 * Every write here lands on a machine the operator owns and uses, so each one starts
 * on a line of its own: a file left without a trailing newline (a hand-edited
 * `authorized_keys` is the usual one) would otherwise have its last entry swallowed
 * into what is appended, invalidating both.
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
        `  printf '\\n%s %s\\n' '${KEY_OPTIONS}' "$(cat ~/.ssh/polaris_tunnel.pub)" >> ~/.ssh/authorized_keys;`,
        "fi",
        // A forward bound off loopback is refused unless sshd allows it. sshd takes the
        // first value it reads and modern distros include sshd_config.d/ from the top of
        // the main file, so a line appended at the end of that file is ignored whenever
        // an included one already decided this: the drop-in is what actually applies.
        // Left to the operator when sshd cannot be edited - the tunnel then fails to
        // bind and says so.
        "gwfile=/etc/ssh/sshd_config",
        "if [ -d /etc/ssh/sshd_config.d ] && grep -qE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\\.d/' /etc/ssh/sshd_config 2>/dev/null; then",
        "  gwfile=/etc/ssh/sshd_config.d/00-polaris-tunnel.conf;",
        "fi",
        "if ! grep -qE '^[[:space:]]*GatewayPorts[[:space:]]+clientspecified' \"$gwfile\" 2>/dev/null; then",
        "  printf '\\nGatewayPorts clientspecified\\n' | sudo tee -a \"$gwfile\" >/dev/null 2>&1 || true;",
        "  sudo systemctl reload sshd >/dev/null 2>&1 || sudo systemctl reload ssh >/dev/null 2>&1 || true;",
        "fi",
        "mkdir -p /var/lib/polaris/traefik/dynamic",
        // Ask Docker where its gateway is rather than assuming the stock subnet: the
        // proxy network first, since that is the one the server's Traefik is on.
        "for polaris_net in polaris-proxy bridge; do",
        `  polaris_gw=$(docker network inspect "$polaris_net" --format ${GATEWAY_FORMAT} 2>/dev/null || sudo docker network inspect "$polaris_net" --format ${GATEWAY_FORMAT} 2>/dev/null || true);`,
        "  case \"$polaris_gw\" in '' | '<no value>') ;; *) printf 'polaris-bind=%s\\n' \"$polaris_gw\"; break ;; esac",
        "done",
        "cat ~/.ssh/polaris_tunnel"
    ].join("\n");
}

/** A dotted-quad, so a docker template that printed an error never becomes a bind
 *  address the forward would fail on. */
function isIpv4(value: string): boolean {
    const parts = value.split(".");
    return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export interface TunnelSetupResult {
    /** The minted private key, or null when the script did not produce one. */
    key: string | null;
    /** Where the forward must bind on that server, falling back to the stock gateway. */
    bindAddress: string;
}

/** Read back what `tunnelSetupScript` printed. */
export function parseTunnelSetup(stdout: string): TunnelSetupResult {
    const start = stdout.indexOf("-----BEGIN");
    const key = start === -1 ? null : stdout.slice(start).trim();
    const gateway = /polaris-bind=(\S+)/.exec(stdout)?.[1] ?? "";
    return {
        key: key && key.includes("-----END") ? key : null,
        bindAddress: isIpv4(gateway) ? gateway : DEFAULT_TUNNEL_BIND_ADDRESS
    };
}
