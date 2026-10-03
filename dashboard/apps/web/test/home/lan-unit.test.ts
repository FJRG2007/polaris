/**
 * Which network a unit on the LAN is on, and the neighbours looked through
 * when one that was on another network than Polaris moves.
 */

import { describe, expect, it } from "vitest";
import { networkOf, subnetAround } from "@polaris-app/places/src/lib/integrations/lan-unit";

describe("the network an address is on", () => {
    it("is its /24", () => {
        expect(networkOf("192.168.50.20")).toBe("192.168.50.0/24");
        expect(networkOf("10.0.2.1")).toBe("10.0.2.0/24");
    });

    it("is nothing for what is not an IPv4 address", () => {
        expect(networkOf("purifier.local")).toBeNull();
        expect(networkOf("fe80::1")).toBeNull();
        expect(networkOf("")).toBeNull();
    });
});

describe("the neighbours of a unit on another network", () => {
    it("are every other address of its private /24", () => {
        const around = subnetAround("192.168.50.20");
        expect(around).toHaveLength(253);
        expect(around).not.toContain("192.168.50.20");
        expect(around).toContain("192.168.50.1");
        expect(around).toContain("192.168.50.254");
    });

    it("are none for a public address, which is never a reason to knock next door", () => {
        expect(subnetAround("8.8.8.8")).toEqual([]);
        expect(subnetAround("100.64.0.10")).toEqual([]);
        expect(subnetAround("not an address")).toEqual([]);
    });
});
