/**
 * What counts as this server's LAN address.
 *
 * The value arrives from a file written by another container, and it ends up in a
 * port-forwarding instruction and a gateway link. Anything that is not an address
 * on a private network turns both into nonsense - a DHCP reservation on a network
 * that does not exist, an "Open the router" link to a stranger's address - so the
 * read is the place that has to be strict about it.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
let file: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "polaris-hostip-"));
    file = join(dir, "host-ip");
    process.env.POLARIS_HOST_IP_FILE = file;
});

afterEach(() => {
    delete process.env.POLARIS_HOST_IP_FILE;
});

/** Re-imported per read: the module resolves the path once, at import time. */
async function readAddress(): Promise<string | null> {
    vi.resetModules();
    const { getHostLanIp } = await import("../../src/lib/host-address");
    return getHostLanIp();
}

describe("getHostLanIp", () => {
    it("accepts an address on each of the private ranges", async () => {
        for (const address of ["192.168.1.20", "10.0.4.7", "172.16.0.5", "172.31.255.254"]) {
            await writeFile(file, `${address}\n`);
            expect(await readAddress()).toBe(address);
        }
    });

    it("refuses an address no router on this network could forward to", async () => {
        // Link-local means the NIC never got a lease; a public address means the
        // responder picked an interface that holds one, or was overridden.
        for (const address of ["169.254.10.4", "85.87.156.88", "127.0.0.1", "172.32.0.1"]) {
            await writeFile(file, `${address}\n`);
            expect(await readAddress()).toBeNull();
        }
    });

    it("answers null rather than throwing when nothing has published one", async () => {
        expect(await readAddress()).toBeNull();
    });

    it("refuses whatever else the file happens to contain", async () => {
        for (const content of ["", "   ", "not-an-address", "192.168.1", "999.1.1.1"]) {
            await writeFile(file, content);
            expect(await readAddress()).toBeNull();
        }
    });
});
