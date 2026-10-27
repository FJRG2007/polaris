/**
 * Which address the mDNS responder advertises as this server's.
 *
 * It is worked out again on every announcement, so a new lease, a move to WiFi or
 * a different network is picked up without a restart. The interface that holds
 * the default route is the network the house is on; without one, the cable wins.
 */

import { describe, expect, it } from "vitest";
import {
    defaultRouteInterfaces,
    defaultRouteInterfaces6,
    globalIpv6,
    lanAddresses
} from "../../../../mdns/address.mjs";

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

// Fixture tables in the kernel's own format. 2001:db8::/32 is the documentation
// range; the rule under test is the 2000::/3 one, which it falls inside.
const ZERO = "0".repeat(32);
const route6 = (name: string, metric = "00000400", flags = "00450003", prefix = "00") =>
    `${ZERO} ${prefix} ${ZERO} 00 fe800000000000000000000000000001 ${metric} 00000001 00000000 ${flags} ${name}`;
const addr6 = (hex: string, name: string, scope = "00", flags = "00") =>
    `${hex} 00000002 40 ${scope} ${flags} ${name}`;
const STABLE = "20010db8000000010000000000000010";
const PRIVACY = "20010db80000000155aa66bb77cc88dd";

describe("the global IPv6", () => {
    it("is the stable address on the default-route interface", () => {
        const table = [
            addr6("fe800000000000000000000000000010", "eth0", "20", "80"),
            addr6(PRIVACY, "eth0", "00", "01"),
            addr6(STABLE, "eth0", "00", "00")
        ].join("\n");
        expect(globalIpv6(table, route6("eth0"))).toBe("2001:db8:0:1:0:0:0:10");
    });

    it("skips temporary, deprecated and tentative addresses", () => {
        for (const flags of ["01", "20", "40"])
            expect(globalIpv6(addr6(STABLE, "eth0", "00", flags), route6("eth0"))).toBeNull();
    });

    it("skips unique-local and link-local addresses", () => {
        const table = [
            addr6("fd000000000000000000000000000001", "eth0"),
            addr6("fe800000000000000000000000000001", "eth0", "20")
        ].join("\n");
        expect(globalIpv6(table, route6("eth0"))).toBeNull();
    });

    it("is none without an IPv6 default route, or one parked on lo", () => {
        expect(globalIpv6(addr6(STABLE, "eth0"), "")).toBeNull();
        expect(globalIpv6(addr6(STABLE, "eth0"), route6("lo"))).toBeNull();
        expect(defaultRouteInterfaces6(route6("eth0", "00000400", "00450003", "40"))).toEqual([]);
    });

    it("ignores an address on another interface or a container bridge", () => {
        const table = [addr6(STABLE, "wlan0"), addr6(STABLE, "docker0")].join("\n");
        expect(globalIpv6(table, route6("eth0"))).toBeNull();
    });
});
