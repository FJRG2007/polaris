/**
 * What a screen is told about where a thing is on the network, and that a thing
 * with no address on it - a device behind a maker's cloud - is told nothing.
 */

import { lanDetails } from "@polaris/core";
import { describe, expect, it } from "vitest";
import { accountNetworks } from "../../../places/src/lib/network-details";
import type { DeviceAccountView } from "../../../places/src/lib/device-accounts";

const table = new Map([["192.0.2.10", "aa:bb:cc:dd:ee:01"]]);
const local = new Map([["192.168.1.10", "aa:bb:cc:dd:ee:01"]]);

function account(connection: string, settings: Record<string, string>): DeviceAccountView {
    return {
        id: "account",
        brand: "Example",
        connection,
        connectionLabel: "Example",
        label: "Example",
        status: "ok",
        statusNote: "",
        lastSyncedAt: null,
        settings,
        options: {},
        deviceCount: 0
    };
}

describe("lanDetails", () => {
    it("finds the hardware address of a local address", () => {
        expect(lanDetails("192.0.2.10", new Map(), "aa:bb:cc:dd:ee:02")).toEqual({
            address: "192.0.2.10",
            mac: null
        });
        expect(
            lanDetails("192.168.1.10", new Map([["192.168.1.10", "aa:bb:cc:dd:ee:01"]]))
        ).toEqual({ address: "192.168.1.10", mac: "AA:BB:CC:DD:EE:01" });
    });

    it("falls back to the one remembered when the table has lost it", () => {
        expect(lanDetails("192.168.1.10", new Map(), "aa:bb:cc:dd:ee:02")).toEqual({
            address: "192.168.1.10",
            mac: "AA:BB:CC:DD:EE:02"
        });
    });

    it("shows the address alone when the table is empty", () => {
        expect(lanDetails("192.168.1.10", new Map())).toEqual({
            address: "192.168.1.10",
            mac: null
        });
    });

    it("turns a device given by MAC into where it answers now", () => {
        expect(lanDetails("AA-BB-CC-DD-EE-01", table)).toEqual({
            address: "192.0.2.10",
            mac: "AA:BB:CC:DD:EE:01"
        });
        expect(lanDetails("AA-BB-CC-DD-EE-09", table)).toEqual({
            address: null,
            mac: "AA:BB:CC:DD:EE:09"
        });
    });

    it("takes a port or a scheme off a stored host", () => {
        expect(lanDetails("https://192.168.1.10:8443/", new Map())?.address).toBe("192.168.1.10");
        expect(lanDetails("nas.example.test:445", new Map())?.address).toBe("nas.example.test");
    });

    it("leaves an IPv6 address whole, taking only a bracketed one's port", () => {
        expect(lanDetails("2001:db8::1", new Map())?.address).toBe("2001:db8::1");
        expect(lanDetails("fe80::1", new Map())?.address).toBe("fe80::1");
        expect(lanDetails("[fe80::1]:22", new Map())?.address).toBe("fe80::1");
        expect(lanDetails("https://[2001:db8::1]:8443/", new Map())?.address).toBe("2001:db8::1");
        expect(lanDetails("[fe80::1]", new Map())?.address).toBe("fe80::1");
    });

    it("has nothing to say about nothing", () => {
        expect(lanDetails("", table)).toBeNull();
        expect(lanDetails(undefined, table)).toBeNull();
    });
});

describe("accountNetworks", () => {
    it("gives nothing for an account with no address field", () => {
        expect(accountNetworks([account("nuki-web", {})], table)).toEqual([]);
    });

    it("gives one entry for an address field that is filled in", () => {
        expect(accountNetworks([account("nuki-local", { host: "192.168.1.10" })], local)).toEqual([
            {
                id: "account:host",
                label: "Example",
                details: { address: "192.168.1.10", mac: "AA:BB:CC:DD:EE:01" }
            }
        ]);
    });

    it("gives nothing for an address field left empty", () => {
        expect(accountNetworks([account("nuki-local", { host: "" })], local)).toEqual([]);
    });
});
