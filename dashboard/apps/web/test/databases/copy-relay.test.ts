/**
 * Where a database's container reaches Polaris for a copy through SSH.
 *
 * The tunnel is opened in the dashboard; the dump runs in the destination's
 * container, which cannot reach the dashboard's loopback. So the tunnel is
 * served on the network the two share, to the container's address alone.
 * These pin which network that is - and that there is none for a database on
 * another machine.
 */

import { describe, expect, it } from "vitest";
import { containerNetworks, sharedNetwork } from "@/lib/database-ops/relay";

const DASHBOARD = [
    { address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true },
    { address: "172.18.0.4", netmask: "255.255.0.0", family: "IPv4", internal: false },
    { address: "10.20.0.7", netmask: "255.255.255.0", family: "IPv4", internal: false },
    { address: "fd00::4", netmask: "ffff:ffff::", family: "IPv6", internal: false }
];

describe("the network a copy's tunnel is served on", () => {
    it("is the one the dashboard and the destination's container share", () => {
        const container = containerNetworks({
            NetworkSettings: {
                Networks: {
                    polaris: { IPAddress: "172.18.0.9", IPPrefixLen: 16 },
                    "polaris-proj": { IPAddress: "10.99.0.2", IPPrefixLen: 24 }
                }
            }
        });
        expect(sharedNetwork(DASHBOARD, container)).toEqual({
            bindHost: "172.18.0.4",
            containerIp: "172.18.0.9"
        });
    });

    it("is none for a container on networks the dashboard is not on", () => {
        const container = containerNetworks({
            NetworkSettings: { Networks: { other: { IPAddress: "192.168.50.3", IPPrefixLen: 24 } } }
        });
        expect(sharedNetwork(DASHBOARD, container)).toBeNull();
    });

    it("never offers loopback, and reads nothing from an inspection it does not understand", () => {
        expect(sharedNetwork(DASHBOARD, [{ ip: "127.0.0.5", prefix: 8 }])).toBeNull();
        expect(containerNetworks({ NetworkSettings: "nope" })).toEqual([]);
        expect(containerNetworks(null)).toEqual([]);
    });
});
