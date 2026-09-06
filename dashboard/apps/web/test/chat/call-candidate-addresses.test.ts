/**
 * The addresses the call server is allowed to hand out.
 *
 * This is asserted against the compose file rather than against code, because
 * the compose file is where it is decided - the call server is configured by one
 * block of YAML handed to it as an environment value, and there is no function
 * in between to test.
 *
 * The rule it holds is one this deployment learned the hard way. A machine
 * running containers has half a dozen bridge addresses; the call server was
 * offering every one of them beside the real address, and a note in the config
 * said they cost "a few wasted checks and nothing else". A call proved
 * otherwise: of two people joining, one settled on 172.18.0.1 - which nothing
 * outside a container can reach - and the other never connected at all and gave
 * up after fifteen seconds.
 *
 * They also decided which address was published as the public one. The server
 * asks STUN from every interface at once, keeps the first answer and discards
 * the rest, so the local address the public one is attached to is a race settled
 * anew on every restart. It landed on the real interface in August and on a
 * container bridge in September, which is what "it worked for days and then
 * stopped for no reason" actually was.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const COMPOSE = readFileSync(new URL("../../../../docker/docker-compose.yml", import.meta.url), "utf8");

/** The excluded ranges, as written in the call server's own configuration. */
const EXCLUDED = [...COMPOSE.matchAll(/^\s*-\s*(\d+\.\d+\.\d+\.\d+\/\d+)\s*$/gm)].map(
    (found) => found[1]!
);

/** An address as the number a mask is compared against. */
function asNumber(address: string): number {
    return address
        .split(".")
        .reduce((total, part) => total * 256 + Number(part), 0);
}

/** Whether a block covers an address, which is the whole of what a CIDR means. */
function covers(block: string, address: string): boolean {
    const [network, bits] = block.split("/");
    const width = Number(bits);
    if (width === 0) return true;
    const mask = (0xffffffff << (32 - width)) >>> 0;
    return ((asNumber(network!) & mask) >>> 0) === ((asNumber(address) & mask) >>> 0);
}

const excluded = (address: string) => EXCLUDED.some((block) => covers(block, address));

describe("the addresses a call may be answered on", () => {
    it("excludes every address a container network hands out", () => {
        // docker0 is the first, and every network created for a project takes
        // the next free /16 upwards from it. Named ones could be listed by name;
        // a project's is `br-` and a hash, and there is nothing to write down -
        // which is why this is done by address.
        for (const bridge of [
            "172.17.0.1",
            "172.18.0.1",
            "172.19.0.1",
            "172.20.0.1",
            "172.21.0.1",
            "172.25.4.1",
            "172.31.255.1"
        ]) {
            expect([bridge, excluded(bridge)]).toEqual([bridge, true]);
        }
    });

    it("excludes libvirt's bridge and an address that means DHCP failed", () => {
        expect(excluded("192.168.122.1")).toBe(true);
        expect(excluded("169.254.13.9")).toBe(true);
    });

    it("leaves every address somebody might actually be called on", () => {
        // The cost of getting this wrong is the opposite failure and a worse
        // one: a house whose own network is hidden from the call server is a
        // house where two people in the same room have their call sent out to
        // the router and back, on a router that will usually not do it.
        for (const real of [
            "192.168.1.142",
            "192.168.0.10",
            "10.0.0.5",
            "10.42.7.1",
            // Docker never allocates from this one, so it is left alone: an
            // office LAN occasionally sits in it.
            "172.16.0.5",
            "85.87.158.186"
        ]) {
            expect([real, excluded(real)]).toEqual([real, false]);
        }
    });

    it("still offers the local address as well as the public one", () => {
        // Without this a call between two devices in the same house leaves it,
        // which is slower and, on a router that will not send a packet back to
        // the network it came from, does not work at all.
        expect(COMPOSE).toContain("advertise_internal_ip: true");
    });
});
