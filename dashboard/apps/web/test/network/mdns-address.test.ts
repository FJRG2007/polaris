/**
 * Which address the mDNS responder advertises as this server's.
 *
 * It is worked out again on every announcement, so a new lease, a move to WiFi or
 * a different network is picked up without a restart. The interface that holds
 * the default route is the network the house is on; without one, the cable wins.
 */

import { describe, expect, it } from "vitest";
import { defaultRouteInterfaces, lanAddresses } from "../../../../mdns/address.mjs";

const HEADER =
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT";

function routes(...lines: string[]): string {
    return [HEADER, ...lines].join("\n");
}

const v4 = (address: string) => ({ address, family: "IPv4", internal: false });

describe("the default route", () => {
    it("names the interfaces with one, lowest metric first", () => {
        const table = routes(
            "wlp2s0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0",
            "br0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0",
            "br0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0"
        );
        expect(defaultRouteInterfaces(table)).toEqual(["br0", "wlp2s0"]);
    });

    it("ignores a route that is down and a table that cannot be read", () => {
        expect(
            defaultRouteInterfaces(
                routes("eth0\t00000000\t0101A8C0\t0002\t0\t0\t0\t00000000\t0\t0\t0")
            )
        ).toEqual([]);
        expect(defaultRouteInterfaces("")).toEqual([]);
        expect(defaultRouteInterfaces(undefined)).toEqual([]);
    });
});

describe("the LAN addresses", () => {
    const interfaces = {
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        docker0: [v4("172.17.0.1")],
        "br-1a2b": [v4("172.18.0.1")],
        veth12: [v4("172.18.0.5")],
        wlp2s0: [v4("192.168.1.31")],
        br0: [v4("192.168.1.20"), { address: "fe80::1", family: "IPv6", internal: false }]
    };

    it("puts the default-route interface first and leaves container plumbing out", () => {
        const table = routes("wlp2s0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0");
        expect(lanAddresses(interfaces, table)).toEqual(["192.168.1.31", "192.168.1.20"]);
    });

    it("prefers the cable when no route can be read", () => {
        expect(lanAddresses(interfaces, "")).toEqual(["192.168.1.20", "192.168.1.31"]);
    });

    it("follows the machine to another network: the new address, nothing of the old", () => {
        const moved = { lo: interfaces.lo, wlp2s0: [v4("10.20.0.14")] };
        const table = routes("wlp2s0\t00000000\t01001408\t0003\t0\t0\t600\t00000000\t0\t0\t0");
        expect(lanAddresses(moved, table)).toEqual(["10.20.0.14"]);
    });

    it("is empty on a machine with no network", () => {
        expect(lanAddresses({ lo: interfaces.lo }, "")).toEqual([]);
    });

    it("advertises the cable on a machine with cable and WiFi on one network", () => {
        const table = routes(
            "wlp2s0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0",
            "br0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0"
        );
        const both = {
            wlp2s0: [v4("192.168.1.149")],
            br0: [v4("192.168.1.142")],
            virbr0: [v4("192.168.122.1")]
        };
        expect(lanAddresses(both, table)).toEqual(["192.168.1.142", "192.168.1.149"]);
    });

    it("never advertises a VPN tunnel, even one that carries the default route", () => {
        const table = routes(
            "wg0\t00000000\t00000000\t0001\t0\t0\t50\t00000000\t0\t0\t0",
            "br0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0"
        );
        const tunnelled = {
            wg0: [v4("10.8.0.2")],
            tun0: [v4("10.9.0.2")],
            br0: [v4("192.168.1.142")]
        };
        expect(lanAddresses(tunnelled, table)).toEqual(["192.168.1.142"]);
    });

    it("never advertises a self-assigned address", () => {
        const unleased = { eth1: [v4("169.254.10.4")], br0: [v4("192.168.1.142")] };
        expect(lanAddresses(unleased, "")).toEqual(["192.168.1.142"]);
    });
});
