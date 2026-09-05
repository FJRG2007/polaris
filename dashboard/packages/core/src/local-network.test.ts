/**
 * "Near me" and "somewhere on the internet".
 *
 * The cost of getting this wrong is asymmetric, which is what the cases below
 * are shaped around. Calling a far address near means one connection attempt
 * that fails before anything is written down. Calling a near address far means a
 * server two metres away is reached through the router for the rest of its life
 * - slower for every byte, and gone entirely when the line is.
 *
 * So the rule is narrow on purpose: only the three ranges a home or office
 * network is actually built out of. Carrier-grade NAT and link-local are not
 * public, and are not reachable from here either.
 */

import { describe, expect, it } from "vitest";
import { alreadyLocal, isLocalAddress, localCandidates, sameLocalNetwork } from "./local-network.js";

describe("what counts as local", () => {
    it("is the three private ranges", () => {
        for (const address of ["10.0.0.5", "10.255.255.254", "172.16.0.1", "172.31.4.9", "192.168.1.7"]) {
            expect(isLocalAddress(address)).toBe(true);
        }
    });

    it("is not everything that fails to be public", () => {
        // Each of these is non-routable on the internet and unreachable from
        // here, which is a different thing: believing one would point Polaris at
        // a machine that cannot answer.
        for (const address of [
            "100.64.0.1", // carrier-grade NAT
            "169.254.1.1", // link-local, a NIC that never got a lease
            "192.0.2.10", // documentation
            "172.32.0.1", // just outside the private block
            "172.15.0.1"
        ]) {
            expect(isLocalAddress(address)).toBe(false);
        }
    });

    it("is not something that is not an address", () => {
        for (const value of ["", "10.0.0", "10.0.0.0.1", "10.0.0.256", "ten.0.0.1", "::1", "server.local"]) {
            expect(isLocalAddress(value)).toBe(false);
        }
    });
});

describe("the same piece of wire", () => {
    it("is the first three octets", () => {
        expect(sameLocalNetwork("192.168.1.7", "192.168.1.50")).toBe(true);
        expect(sameLocalNetwork("192.168.1.7", "192.168.2.50")).toBe(false);
    });

    it("is never true of an address that is not local at all", () => {
        expect(sameLocalNetwork("203.0.113.7", "203.0.113.9")).toBe(false);
    });
});

describe("where a machine might be reached", () => {
    const NEAR = "192.168.1.50";

    it("puts an address on our own network first", () => {
        expect(localCandidates(["10.8.0.4", "192.168.1.7"], NEAR)).toEqual(["192.168.1.7", "10.8.0.4"]);
    });

    it("keeps a private address on another network as a second-best", () => {
        // It may be behind a router that does route between them; trying costs
        // one handshake that either answers as the machine or does not.
        expect(localCandidates(["10.8.0.4"], NEAR)).toEqual(["10.8.0.4"]);
    });

    it("leaves out everything that could not be reached directly", () => {
        expect(localCandidates(["203.0.113.9", "169.254.7.1", "100.64.0.1"], NEAR)).toEqual([]);
    });

    it("never offers Polaris its own address", () => {
        // On a host-networked install that is the box Polaris runs on, and a
        // server pointed at it would be a server pointed at Polaris.
        expect(localCandidates([NEAR, "192.168.1.7"], NEAR)).toEqual(["192.168.1.7"]);
    });

    it("says nothing when Polaris does not know where it is", () => {
        expect(localCandidates(["192.168.1.7"], null)).toEqual([]);
        expect(localCandidates(["192.168.1.7"], "203.0.113.9")).toEqual([]);
    });

    it("does not offer the same address twice", () => {
        // Two interfaces on one network, or a machine that lists an address
        // under both of the tools this asks.
        expect(localCandidates(["192.168.1.7", " 192.168.1.7 "], NEAR)).toEqual(["192.168.1.7"]);
    });
});

describe("a server already reached directly", () => {
    it("has nothing to offer", () => {
        expect(alreadyLocal("192.168.1.7", "192.168.1.50")).toBe(true);
        expect(alreadyLocal("server.example.com", "192.168.1.50")).toBe(false);
        expect(alreadyLocal("192.168.1.7", null)).toBe(false);
    });
});
