/**
 * The host firewall: what the status read says, and the ports a change leaves
 * open, derived from what is on the server rather than from a list anybody
 * wrote. Pure, so the derivation can be asserted in a test.
 *
 * What stays open: SSH (every SSH listener, and the port Polaris itself logs in
 * on), the web edge, calls and local discovery on the Polaris machine itself,
 * every port a container publishes (stopped ones included, so a game server
 * that sleeps until somebody joins is still reachable), every socket a
 * container on the host network listens on, and the VPN's WireGuard port.
 * Container, VPN and virtual-machine networks are never filtered. Anything
 * else listening on an outside address is listed as closing, and stays open
 * only when a person keeps it open.
 */

export type FirewallState = "on" | "armed" | "off";
export type OtherFirewall = "ufw" | "firewalld";
export type Protocol = "tcp" | "udp";

/** A socket listening on the server, as `ss` printed it. */
export interface Listener {
    readonly word: string;
    readonly address: string;
    /** The process, or the systemd socket unit that holds it for one. */
    readonly process: string | null;
    /** The container it runs in, when it does. */
    readonly container: string | null;
}

export interface FirewallReport {
    readonly distro: string | null;
    /** nftables is installed (an apply installs it when it is not). */
    readonly nft: boolean;
    /** The Router app's own firewall is on this machine. */
    readonly router: boolean;
    readonly state: FirewallState;
    /** What the last confirmed change left open. */
    readonly allowed: readonly string[];
    /** The firewall Polaris's replaced, which comes back when it is turned off. */
    readonly replaced: OtherFirewall | null;
    /** Another firewall that is on now. */
    readonly other: OtherFirewall | null;
    readonly addresses: readonly { readonly iface: string; readonly address: string }[];
    readonly wireguard: readonly number[];
    readonly bound: readonly { readonly container: string; readonly words: readonly string[] }[];
    readonly listeners: readonly Listener[];
}

export type OpenReason = "ssh" | "web" | "calls" | "discovery" | "vpn" | "container" | "kept";

export interface OpenPort {
    readonly word: string;
    readonly reason: OpenReason;
    /** The container or process it is open for, when there is one to name. */
    readonly detail: string | null;
}

export interface ClosingPort {
    readonly word: string;
    readonly process: string | null;
}

export interface FirewallPlan {
    readonly open: readonly OpenPort[];
    readonly closing: readonly ClosingPort[];
    /** Why no change can be applied here, when one cannot. */
    readonly blocked: "router" | null;
    /** The firewall an apply turns off in favour of Polaris's own. */
    readonly replaces: OtherFirewall | null;
    /** Something would open that the running firewall does not allow yet. */
    readonly opens: boolean;
}

/** One port as the daemon takes it: `tcp:22`. */
export const PORT_WORD = /^(tcp|udp):([1-9][0-9]{0,4})$/;

export function isPortWord(word: string): boolean {
    const match = PORT_WORD.exec(word);
    return match !== null && Number(match[2]) <= 65535;
}

/** Interfaces that are the server's own containers, VPNs and virtual machines;
 *  the same list the call server leaves out when it picks its address. */
const INNER = /^(lo|docker|br-|veth|virbr|cni|flannel|kube|tailscale|zt|wg|tun|tap|podman|lxcbr|lxdbr|vboxnet|vmnet)/;

const SSH_PROCESSES = new Set(["sshd", "ssh.socket", "sshd.socket"]);

/** Always open on a managed server: the web edge, HTTP/3 included. */
const WEB: readonly string[] = ["tcp:80", "tcp:443", "udp:443"];
/** Open on the Polaris machine itself: calls (signalling, TCP and UDP media). */
const CALLS: readonly string[] = ["tcp:7880", "tcp:7881", "udp:7882"];
/** Open on the Polaris machine itself: devices finding it on the network. */
const DISCOVERY: readonly string[] = ["udp:5353"];

function value(line: string, key: string): string | null {
    return line.startsWith(`${key}=`) ? line.slice(key.length + 1).trim() : null;
}

function other(word: string | null): OtherFirewall | null {
    return word === "ufw" || word === "firewalld" ? word : null;
}

/** The address a socket is bound to, without brackets; its interface when bound to one. */
function splitAddress(raw: string): { address: string; iface: string | null } {
    const [address = "", iface = null] = raw.split("%");
    return { address: address.replace(/^\[|\]$/g, ""), iface };
}

/** A status read, or null when the output is not one (an older daemon's, a failure). */
export function parseFirewallLog(output: string): FirewallReport | null {
    let distro: string | null = null;
    let state: FirewallState | null = null;
    let nft = false;
    let router = false;
    let replaced: OtherFirewall | null = null;
    let running: OtherFirewall | null = null;
    const allowed: string[] = [];
    const addresses: { iface: string; address: string }[] = [];
    const wireguard: number[] = [];
    const bound: { container: string; words: string[] }[] = [];
    const listeners: Listener[] = [];
    for (const raw of output.split("\n")) {
        const line = raw.trim();
        if (line.startsWith("POLARIS_DISTRO id=")) distro = line.slice(18) || null;
        const firewall = value(line, "POLARIS_FIREWALL");
        if (firewall === "on" || firewall === "armed" || firewall === "off") state = firewall;
        if (value(line, "POLARIS_NFT") === "yes") nft = true;
        if (value(line, "POLARIS_ROUTER") === "yes") router = true;
        replaced = other(value(line, "POLARIS_REPLACED")) ?? replaced;
        running = other(value(line, "POLARIS_OTHER")) ?? running;
        const kept = value(line, "POLARIS_ALLOWED");
        if (kept && isPortWord(kept)) allowed.push(kept);
        const address = value(line, "POLARIS_ADDR");
        if (address) {
            const [iface, ip] = address.split(/\s+/);
            if (iface && ip) addresses.push({ iface, address: ip });
        }
        const port = Number(value(line, "POLARIS_WG") ?? Number.NaN);
        if (Number.isInteger(port) && port > 0 && port <= 65535) wireguard.push(port);
        const published = value(line, "POLARIS_BOUND");
        if (published) {
            const [container = "", ...ports] = published.split(/\s+/);
            const words = ports.flatMap((entry) => {
                // "25565/tcp=25565"; an empty host port is one the engine picks.
                const match = /^\d+\/(tcp|udp)=(\d+)$/.exec(entry);
                const word = match ? `${match[1]}:${match[2]}` : "";
                return isPortWord(word) ? [word] : [];
            });
            if (container && words.length > 0) bound.push({ container, words });
        }
        const listen = value(line, "POLARIS_LISTEN");
        if (listen) {
            const [proto, number, address = "", process = "-", container = "-"] = listen.split(/\s+/);
            const word = `${proto}:${number}`;
            if ((proto === "tcp" || proto === "udp") && isPortWord(word)) {
                listeners.push({
                    word,
                    address,
                    process: process === "-" ? null : process,
                    container: container === "-" ? null : container
                });
            }
        }
    }
    if (!state) return null;
    return {
        distro,
        nft,
        router,
        state,
        allowed,
        replaced,
        other: running,
        addresses,
        wireguard,
        bound,
        listeners
    };
}

/** Whether a listener can be reached from outside the server at all. */
function reachable(listener: Listener, inner: ReadonlySet<string>): boolean {
    const { address, iface } = splitAddress(listener.address);
    if (iface !== null && INNER.test(iface)) return false;
    if (address.startsWith("127.") || address === "::1") return false;
    return !inner.has(address);
}

/**
 * The ports a change leaves open and the listeners it closes. `sshPort` is the
 * port Polaris logs in on (none for the machine it runs on); `keep` the ports a
 * person chose to keep open.
 */
export function planFirewall(
    report: FirewallReport,
    options: { local: boolean; sshPort: number | null; keep: readonly string[] }
): FirewallPlan {
    const open = new Map<string, OpenPort>();
    const add = (word: string, reason: OpenReason, detail: string | null = null) => {
        if (isPortWord(word) && !open.has(word)) open.set(word, { word, reason, detail });
    };
    if (options.sshPort !== null) add(`tcp:${options.sshPort}`, "ssh");
    for (const listener of report.listeners) {
        if (listener.process && SSH_PROCESSES.has(listener.process)) add(listener.word, "ssh");
    }
    for (const word of WEB) add(word, "web");
    if (options.local) {
        for (const word of CALLS) add(word, "calls");
        for (const word of DISCOVERY) add(word, "discovery");
    }
    for (const port of report.wireguard) add(`udp:${port}`, "vpn");
    for (const { container, words } of report.bound) {
        for (const word of words) add(word, "container", container);
    }
    for (const listener of report.listeners) {
        if (listener.container) add(listener.word, "container", listener.container);
        else if (listener.process === "docker-proxy") add(listener.word, "container");
    }
    const inner = new Set(
        report.addresses.filter(({ iface }) => INNER.test(iface)).map(({ address }) => address)
    );
    const closing = new Map<string, ClosingPort>();
    for (const listener of report.listeners) {
        if (open.has(listener.word) || closing.has(listener.word)) continue;
        if (!reachable(listener, inner)) continue;
        if (options.keep.includes(listener.word)) {
            add(listener.word, "kept", listener.process);
            continue;
        }
        closing.set(listener.word, { word: listener.word, process: listener.process });
    }
    const allowed = new Set(report.allowed);
    return {
        open: [...open.values()],
        closing: [...closing.values()],
        blocked: report.router ? "router" : null,
        replaces: report.other,
        opens: report.state !== "on" || [...open.keys()].some((word) => !allowed.has(word))
    };
}

export type FirewallStep = "sync" | "review" | null;

/**
 * What the periodic pass does for one server. It never turns a firewall on:
 * default-deny closes what Polaris does not know about, so only a person who
 * saw what would close does that. "sync" re-applies a firewall a person turned
 * on, to open what was deployed since; "review" tells the owner, once, that the
 * server has none.
 */
export function firewallStep(
    setting: { readonly firewallChoice: string | null; readonly firewallNotifiedAt: Date | null } | null,
    view: { readonly state: FirewallState | "router"; readonly plan: FirewallPlan }
): FirewallStep {
    if (view.plan.blocked || view.state === "router") return null;
    if (view.state === "on") {
        return setting?.firewallChoice === "on" && view.plan.opens ? "sync" : null;
    }
    if (view.state === "off" && !setting?.firewallChoice && !setting?.firewallNotifiedAt) return "review";
    return null;
}

/** What an apply or confirm answered. */
export type FirewallEnding =
    | "armed"
    | "confirmed"
    | "rolled-back"
    | "unavailable"
    | "router"
    | "invalid"
    | "failed"
    | "unknown";

const ENDINGS: readonly FirewallEnding[] = [
    "armed",
    "confirmed",
    "rolled-back",
    "unavailable",
    "router",
    "invalid",
    "failed",
    "unknown"
];

export function parseFirewallEnding(output: string): FirewallEnding | null {
    for (const raw of output.split("\n")) {
        const word = value(raw.trim(), "POLARIS_FIREWALL");
        if (word && (ENDINGS as readonly string[]).includes(word)) return word as FirewallEnding;
    }
    return null;
}
