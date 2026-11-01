/**
 * What a machine is told to do: a plan the schema accepts renders to a firewall that
 * opens only what was asked, and one that would break the machine never gets there.
 */

import { describe, expect, it } from "vitest";
import * as router from "@/lib/router/plan";
import { readProbe } from "@/lib/router/read";
import { refusalOf } from "@/lib/router/service";

const LAN = {
    id: "0190f1c2-0000-7000-8000-000000000001",
    name: "Home",
    interface: "eth1",
    vlan: null,
    cidr: "10.77.0.0/24",
    address: "10.77.0.1",
    internet: true,
    isolated: false,
    reservations: []
};
const PLAN = { wans: [{ interface: "eth0", vlan: null }], lans: [LAN], forwards: [] };
const ACCESS = { management: "192.0.2.9", sshPort: 22 };
const parsed = (plan: unknown) => router.routerPlanSchema.parse(plan);

describe("a router plan", () => {
    it("refuses a name that could leave its place in a script", () => {
        const wans = [{ interface: "eth0; reboot", vlan: null }];
        expect(router.routerPlanSchema.safeParse({ ...PLAN, wans }).success).toBe(false);
    });

    it("refuses two links on one port, and accepts them on a VLAN", () => {
        const onLine = { ...LAN, interface: "eth0" };
        expect(router.routerPlanSchema.safeParse({ ...PLAN, lans: [onLine] }).success).toBe(false);
        const tagged = { ...onLine, vlan: 20 };
        expect(router.routerPlanSchema.safeParse({ ...PLAN, lans: [tagged] }).success).toBe(true);
    });

    it("takes a USB adapter's long name, and keeps its VLAN within what Linux allows", () => {
        const lans = [{ ...LAN, interface: "enx00e04c680001", vlan: 2000 }];
        const plan = parsed({ ...PLAN, lans });
        const device = router.deviceOf(plan.lans[0] ?? LAN);
        expect(device.length).toBeLessThanOrEqual(15);
        expect(router.renderUp(plan)).toContain(`name ${device} type vlan id 2000`);
    });

    it("refuses a forward to an address behind no network", () => {
        const forwards = [{ protocol: "tcp", port: 80, address: "10.99.0.5", toPort: 80 }];
        expect(router.routerPlanSchema.safeParse({ ...PLAN, forwards }).success).toBe(false);
    });
});

describe("the firewall", () => {
    it("keeps what Polaris uses open and drops the rest from a line", () => {
        const rules = router.renderFirewall(parsed(PLAN), ACCESS);
        expect(rules).toContain("policy drop");
        expect(rules).toContain("ip saddr 192.0.2.9 tcp dport 22 accept");
        expect(rules).toContain('oifname { "eth0" } masquerade');
    });

    it("gives a network without internet no way out, and an isolated one no login", () => {
        const lan = { ...LAN, internet: false, isolated: true };
        const rules = router.renderFirewall(parsed({ ...PLAN, lans: [lan] }), ACCESS);
        expect(rules).not.toContain('iifname { "eth1" } oifname { "eth0" } accept');
        expect(rules).toContain('iifname { "eth1" } tcp dport 22 drop');
    });
});

describe("applying", () => {
    it("arms the way back before the network is touched", () => {
        const script = router.renderApply(parsed(PLAN), ACCESS);
        const armed = script.indexOf("--unit=polaris-router-rollback");
        expect(armed).toBeGreaterThan(-1);
        expect(armed).toBeLessThan(script.indexOf("--unit=polaris-router-activate"));
        expect(script.indexOf("nft -c -f")).toBeLessThan(armed);
    });
});

describe("what is refused before anything is sent", () => {
    const reading = {
        ports: [
            { name: "eth0", up: true, mac: null, addresses: ["192.168.1.5/24"], hasGateway: true, received: 0, sent: 0 },
            { name: "eth1", up: true, mac: null, addresses: ["192.168.2.5/24"], hasGateway: false, received: 0, sent: 0 }
        ],
        activeWan: null,
        running: false,
        clients: [],
        rolledBack: false
    };

    it("a port the machine does not have", () => {
        const lans = [{ ...LAN, interface: "eth9" }];
        expect(refusalOf(parsed({ ...PLAN, lans }), reading, "192.168.1.5")).toBe("missingPort");
    });

    it("a network on the subnet of a line", () => {
        const lans = [{ ...LAN, cidr: "192.168.1.0/24", address: "192.168.1.1" }];
        expect(refusalOf(parsed({ ...PLAN, lans }), reading, "192.168.1.5")).toBe("lineOverlap");
    });

    it("taking the port Polaris arrives by", () => {
        expect(refusalOf(parsed(PLAN), reading, "192.168.2.5")).toBe("lockout");
        expect(refusalOf(parsed(PLAN), reading, "192.168.1.5")).toBeNull();
    });
});

describe("reading a machine", () => {
    it("takes what it can and leaves out what it cannot read", () => {
        const reading = readProbe(
            [
                "---links",
                '[{"ifname":"lo"},{"ifname":"eth0","operstate":"UP","address":"aa:bb:cc:dd:ee:ff"},{"nonsense":1}]',
                "---addresses",
                '[{"ifname":"eth0","addr_info":[{"local":"192.168.1.5","prefixlen":24}]}]',
                "---routes",
                '[{"dev":"eth0","gateway":"192.168.1.1"}]',
                "---wan",
                "eth0",
                "---services",
                "active",
                "active",
                "active",
                "---leases",
                "1700000000 aa:bb:cc:00:00:01 10.77.0.100 plug *",
                "garbage",
                "---counters",
                "not json",
                "---last",
                "---end"
            ].join("\n")
        );
        expect(reading.ports).toHaveLength(1);
        expect(reading.ports[0]?.hasGateway).toBe(true);
        expect(reading.activeWan).toBe("eth0");
        expect(reading.running).toBe(true);
        expect(reading.clients).toEqual([
            { address: "10.77.0.100", mac: "aa:bb:cc:00:00:01", name: "plug", expires: 1700000000 }
        ]);
    });
});
