/**
 * Finding the cameras that are already on the network.
 *
 * Nobody knows their camera's IP address. They know it is "the one by the front
 * door", and asking them for an address is asking them to open a router page and
 * read a table - which is where adding a camera usually stops. So Polaris looks
 * for them, two ways, because neither finds everything on its own:
 *
 * - **Asking out loud.** ONVIF devices answer a multicast probe with their own
 *   address and a few words about themselves. This is the good one: it finds
 *   cameras on any port, names them, and costs one UDP packet.
 * - **Knocking on doors.** A sweep of the subnet for the ports cameras answer
 *   on. It finds the ones with multicast blocked - an access point in client
 *   isolation mode, a repeater, a guest network - which on a home network is
 *   more common than it should be.
 *
 * Both run on whichever machine is asked to look, which is what makes a camera
 * on another network findable at all: the sweep is done by a server that lives
 * there rather than by a Polaris that cannot see it.
 *
 * Server-only.
 */

import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import { tagValue } from "@/lib/home/onvif";

/** The address every ONVIF device listens for probes on. */
const WS_DISCOVERY_ADDRESS = "239.255.255.250";
const WS_DISCOVERY_PORT = 3702;

/** How long to keep listening. Cameras answer in well under a second; the rest
 *  of the wait is for the one on a slow access point. */
const PROBE_WINDOW_MS = 3000;

/** Ports worth knocking on, and what answering one means. 2020 is here because
 *  Tapo puts its ONVIF service there rather than on 80, and a sweep without it
 *  finds none of them. */
const PROBE_PORTS = [554, 2020, 80, 8000] as const;

/** How many hosts are probed at once. High enough to sweep a /24 in seconds, low
 *  enough not to look like a port scan to a router that is watching. */
const SWEEP_CONCURRENCY = 32;

const CONNECT_TIMEOUT_MS = 700;

export interface DiscoveredCamera {
    /** Where it is. The only field that is always known. */
    readonly address: string;
    /** Its ONVIF service port, when it was found by asking rather than knocking. */
    readonly onvifPort: number | null;
    /** What it calls itself, when it said. */
    readonly name: string | null;
    /** The make Polaris thinks it is, matched against the profiles it knows, so
     *  the add form can arrive already filled in. */
    readonly vendor: string | null;
    /** "probe" when it answered the multicast, "sweep" when a port was open.
     *  Worth showing: a sweep hit is a maybe, a probe answer is a camera. */
    readonly via: "probe" | "sweep";
    /** Ports found open, for a sweep hit. */
    readonly ports: readonly number[];
}

/** The probe document. A single message, and the only one Polaris ever sends to
 *  the whole network. */
function probeMessage(): string {
    return `<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><e:Header><w:MessageID>uuid:${randomUUID()}</w:MessageID><w:To e:mustUnderstand="1">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action e:mustUnderstand="1">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>`;
}

/** What a device's ONVIF scopes say it is, matched to a profile Polaris knows.
 *  Scopes are free text the vendor chose, so this reads the whole blob rather
 *  than one field: makers put the model in `name`, in `hardware`, or in both. */
export function vendorFromScopes(text: string): string | null {
    const haystack = text.toLowerCase();
    if (haystack.includes("tapo")) return "tapo";
    if (haystack.includes("vigi")) return "vigi";
    if (haystack.includes("reolink")) return "reolink";
    if (haystack.includes("hikvision")) return "hikvision";
    if (haystack.includes("dahua")) return "dahua";
    if (haystack.includes("amcrest")) return "amcrest";
    return null;
}

/** The name out of an ONVIF scope list, which is where a camera puts the thing a
 *  person would recognize ("onvif://www.onvif.org/name/Front%20door"). */
function nameFromScopes(scopes: string): string | null {
    const match = /onvif:\/\/www\.onvif\.org\/name\/([^\s<]+)/i.exec(scopes);
    if (!match?.[1]) return null;
    try {
        return decodeURIComponent(match[1]).replace(/_/g, " ");
    } catch {
        return match[1];
    }
}

/**
 * Ask the network what cameras are on it.
 *
 * Resolves when the listening window closes rather than on the first answer:
 * every camera replies at its own pace and the point is the whole list. A
 * network that blocks multicast simply answers nothing, which is not an error -
 * it is why the sweep below exists.
 */
export async function probeNetwork(windowMs = PROBE_WINDOW_MS): Promise<DiscoveredCamera[]> {
    return new Promise((resolve) => {
        const found = new Map<string, DiscoveredCamera>();
        const socket = createSocket({ type: "udp4", reuseAddr: true });
        const finish = () => {
            try {
                socket.close();
            } catch {
                // Already closed; the answers collected so far are the answer.
            }
            resolve([...found.values()]);
        };

        socket.on("error", finish);
        socket.on("message", (message) => {
            const xml = message.toString("utf8");
            const xaddrs = tagValue(xml, "XAddrs") ?? "";
            const scopes = tagValue(xml, "Scopes") ?? "";
            // A device lists every address it answers on, its own LAN one first.
            const first = xaddrs.split(/\s+/).find((value) => value.startsWith("http"));
            if (!first) return;
            let address: string;
            let port: number;
            try {
                const url = new URL(first);
                address = url.hostname;
                port = url.port ? Number.parseInt(url.port, 10) : 80;
            } catch {
                return;
            }
            found.set(address, {
                address,
                onvifPort: port,
                name: nameFromScopes(scopes),
                vendor: vendorFromScopes(`${scopes} ${xml}`),
                via: "probe",
                ports: [port]
            });
        });

        socket.bind(() => {
            try {
                socket.setBroadcast(true);
                socket.setMulticastTTL(1);
            } catch {
                // Some hosts refuse both; the send below still reaches a device
                // on the same segment.
            }
            socket.send(probeMessage(), WS_DISCOVERY_PORT, WS_DISCOVERY_ADDRESS, (error) => {
                if (error) finish();
            });
            setTimeout(finish, windowMs);
        });
    });
}

/** Whether something is listening, without saying anything to it. A connect and
 *  an immediate close is the whole test: cameras are the only things on a home
 *  network with 554 open, and nothing is sent that a service could act on. */
function portOpen(address: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new Socket();
        const done = (open: boolean) => {
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(CONNECT_TIMEOUT_MS);
        socket.once("connect", () => done(true));
        socket.once("timeout", () => done(false));
        socket.once("error", () => done(false));
        socket.connect(port, address);
    });
}

/** Every address in a CIDR, host addresses only. Refuses anything wider than a
 *  /22: a sweep of a /16 is sixty-five thousand connect attempts and an hour of
 *  waiting, which is never what somebody meant. */
export function hostsInCidr(cidr: string): string[] {
    const [base, bitsText] = cidr.split("/");
    const bits = Number.parseInt(bitsText ?? "", 10);
    if (!base || !Number.isFinite(bits) || bits < 22 || bits > 32) return [];
    const octets = base.split(".").map((part) => Number.parseInt(part, 10));
    if (octets.length !== 4 || octets.some((octet) => !Number.isFinite(octet) || octet < 0 || octet > 255)) return [];
    const start = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
    const size = 2 ** (32 - bits);
    const network = start & (size === 2 ** 32 ? 0 : ~(size - 1) >>> 0);
    const addresses: string[] = [];
    // Network and broadcast addresses are not hosts, so a /24 sweeps .1 to .254.
    for (let offset = 1; offset < size - 1; offset += 1) {
        const value = (network + offset) >>> 0;
        addresses.push([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join("."));
    }
    return addresses;
}

/**
 * Knock on every door in a subnet and report what answered.
 *
 * Bounded on purpose: a fixed handful of ports, a short timeout, and a
 * concurrency cap. It is a slow way to find a camera and the only way to find
 * one that multicast cannot reach.
 */
export async function sweepSubnet(cidr: string): Promise<DiscoveredCamera[]> {
    const hosts = hostsInCidr(cidr);
    if (hosts.length === 0) return [];
    const found: DiscoveredCamera[] = [];
    let next = 0;
    const worker = async () => {
        while (next < hosts.length) {
            const address = hosts[next++]!;
            const open: number[] = [];
            for (const port of PROBE_PORTS) {
                if (await portOpen(address, port)) open.push(port);
            }
            // 554 is the one that means camera. A box with only 80 open is a
            // printer, a router, or a light switch, and listing it as a camera
            // wastes the reader's attention.
            if (!open.includes(554)) continue;
            found.push({
                address,
                onvifPort: open.find((port) => port === 2020 || port === 80) ?? null,
                name: null,
                vendor: null,
                via: "sweep",
                ports: open
            });
        }
    };
    await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, hosts.length) }, worker));
    return found;
}

/**
 * Sweep a network Polaris cannot see, from a server that can.
 *
 * This is the case the whole `reachVia` idea exists for: a camera on a repeater,
 * a guest network, or another building. Polaris cannot knock on those doors, and
 * the machine that lives there can - so the knocking is done there, over the
 * connection Polaris already has to it, and only the list of addresses comes
 * back.
 *
 * Written as one bash line rather than a script pushed to the host: it is a loop
 * with a timeout in it, every server has bash, and nothing is left behind on the
 * machine afterwards.
 */
export async function sweepFromServer(hostId: string, ownerId: string, cidr: string): Promise<DiscoveredCamera[]> {
    const hosts = hostsInCidr(cidr);
    if (hosts.length === 0) return [];
    const { getHostConnection } = await import("@/lib/host-service");
    const { execCommand, openSshClient } = await import("@polaris/ssh");
    const connection = await getHostConnection(hostId, ownerId);

    // `/dev/tcp` is bash's own way of opening a socket, so this needs nothing
    // installed. The subshells run in parallel and each one gives up after a
    // second, which keeps a /24 to a few seconds rather than four minutes.
    const base = hosts[0]!.split(".").slice(0, 3).join(".");
    const command = `for i in $(seq 1 254); do (timeout 1 bash -c "echo > /dev/tcp/${base}.$i/554" 2>/dev/null && echo ${base}.$i) & done; wait`;

    const client = await openSshClient({
        host: connection.address,
        port: connection.port,
        username: connection.username,
        auth: connection.auth,
        ...(connection.hostKey ? { pinnedHostKey: connection.hostKey } : {})
    });
    try {
        let output = "";
        await execCommand(client, command, { onStdout: (chunk) => (output += chunk.toString("utf8")) });
        return output
            .split(/\s+/)
            .map((line) => line.trim())
            .filter((line) => /^(\d{1,3}\.){3}\d{1,3}$/.test(line))
            .map((address) => ({
                address,
                onvifPort: null,
                name: null,
                vendor: null,
                via: "sweep" as const,
                ports: [554] as readonly number[]
            }));
    } finally {
        client.end();
    }
}

/**
 * Both ways of looking, merged.
 *
 * What the multicast found wins over what the sweep found for the same address:
 * one of them knows the camera's name and its ONVIF port, the other only knows
 * that something is listening.
 */
export async function discoverCameras(
    subnet: string,
    from?: { hostId: string; ownerId: string } | null
): Promise<DiscoveredCamera[]> {
    // Asked to look from another machine, that is the only place worth looking:
    // this one has already been established not to see that network.
    if (from && subnet) return sweepFromServer(from.hostId, from.ownerId, subnet);
    const [probed, swept] = await Promise.all([
        probeNetwork(),
        subnet ? sweepSubnet(subnet) : Promise.resolve([] as DiscoveredCamera[])
    ]);
    const merged = new Map<string, DiscoveredCamera>();
    for (const camera of swept) merged.set(camera.address, camera);
    for (const camera of probed) merged.set(camera.address, camera);
    return [...merged.values()].sort((left, right) => left.address.localeCompare(right.address, undefined, { numeric: true }));
}
