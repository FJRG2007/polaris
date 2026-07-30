/**
 * This server's address on the local network.
 *
 * The web container cannot see it: everything it has an interface on is a docker
 * bridge, and its own address there means nothing to a router. The mDNS responder
 * runs on the host network - it has to, multicast does not cross a bridge - so it
 * is the one part of the stack that knows, and it writes the address to the shared
 * volume for whoever needs it. Read from there, never guessed: a wrong address in a
 * port-forwarding instruction sends the operator to configure the wrong machine.
 */

import { readFile } from "node:fs/promises";

const IP_FILE = process.env.POLARIS_HOST_IP_FILE ?? "/run/polaris/host-ip";
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * The LAN IPv4 this server answers on, or null when it is not published - an
 * install without the responder (Docker Desktop restricts host networking) or one
 * that has not written the file yet. Validated on the way out: it is read from a
 * file, so nothing downstream should assume it is even an address.
 */
export async function getHostLanIp(): Promise<string | null> {
    const raw = await readFile(IP_FILE, "utf8").catch(() => null);
    if (raw === null) return null;
    const value = raw.trim();
    return IPV4.test(value) && !value.startsWith("127.") ? value : null;
}
