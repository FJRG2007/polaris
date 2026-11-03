/**
 * What the Router screen suggests: the next free VLAN tag of a port, which lines and
 * networks collide on one device, the network a clash is best ended by tagging, and a
 * machine with a single wired port.
 */

import { describe, expect, it } from "vitest";
import { routerPlanSchema, type RouterLan, type RouterPlan } from "@/lib/router/plan";
import * as assist from "@/lib/router/assist";

const LAN: RouterLan = {
    id: "0190f1c2-0000-7000-8000-000000000001",
    name: "Test",
    interface: "ens6",
    vlan: null,
    cidr: "10.77.0.0/24",
    address: "10.77.0.1",
    internet: true,
    isolated: false,
    reservations: []
};

/** The operator's machine: one port that is both the line and the network. */
const ONE_PORT: RouterPlan = {
    wans: [{ interface: "ens6", vlan: null }],
    lans: [LAN],
    forwards: []
};

describe("nextFreeVlan", () => {
    it("offers round tags first and skips the ones the port uses", () => {
        expect(assist.nextFreeVlan([], "ens6")).toBe(10);
        const links = assist.linksOf(assist.withLanVlan(ONE_PORT, LAN.id, 10));
        expect(assist.nextFreeVlan(links, "ens6")).toBe(20);
        expect(assist.nextFreeVlan(links, "eth1")).toBe(10);
    });

    it("falls back to the lowest free tag once the round ones are taken", () => {
        const links = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((vlan) => ({
            kind: "network" as const,
            key: String(vlan),
            name: String(vlan),
            port: "eth0",
            vlan
        }));
        expect(assist.nextFreeVlan(links, "eth0")).toBe(2);
    });
});

describe("portClashes and clashFix", () => {
    it("names a line and a network sharing a port untagged and moves the network", () => {
        const clashes = assist.portClashes(ONE_PORT);
        expect(clashes).toHaveLength(1);
        expect(clashes[0]?.links.map(({ kind }) => kind)).toEqual(["line", "network"]);
        const fix = assist.clashFix(ONE_PORT, clashes[0]!);
        expect(fix).toEqual({ lanId: LAN.id, vlan: 10 });
        const fixed = assist.withLanVlan(ONE_PORT, fix!.lanId, fix!.vlan);
        expect(assist.portClashes(fixed)).toEqual([]);
        expect(routerPlanSchema.safeParse(ONE_PORT).success).toBe(false);
        expect(routerPlanSchema.safeParse(fixed).success).toBe(true);
    });

    it("never offers to tag a network on the air, nor a line", () => {
        const wifi = { ...LAN, wifi: { ssid: "Fixture", country: "ES", band: "5" as const } };
        const plan = { ...ONE_PORT, lans: [wifi] };
        expect(assist.clashFix(plan, assist.portClashes(plan)[0]!)).toBeNull();
        const lines = { ...ONE_PORT, wans: [...ONE_PORT.wans, { interface: "ens6", vlan: null }] };
        const onlyLines = assist.portClashes({ ...lines, lans: [] })[0]!;
        expect(assist.clashFix({ ...lines, lans: [] }, onlyLines)).toBeNull();
    });

    it("sees no clash between two VLANs of one port", () => {
        const plan = assist.withLanVlan(ONE_PORT, LAN.id, 20);
        expect(assist.portClashes(plan)).toEqual([]);
    });
});

describe("field checks", () => {
    it("names who already holds a port's untagged traffic or a tag", () => {
        const links = assist.linksOf(ONE_PORT);
        const self = { kind: "network" as const, key: "new" };
        expect(assist.vlanTakenBy(links, self, "ens6", null)?.kind).toBe("line");
        expect(assist.vlanTakenBy(links, self, "ens6", 10)).toBeNull();
        expect(assist.vlanTakenBy(links, { kind: "network", key: LAN.id }, "ens6", null)?.kind).toBe(
            "line"
        );
    });

    it("refuses a tag outside 2 to 4094", () => {
        expect(assist.vlanError(null)).toBeNull();
        expect(assist.vlanError(1)).toBe("badVlan");
        expect(assist.vlanError(4095)).toBe("badVlan");
        expect(assist.vlanError(4094)).toBeNull();
    });

    it("counts the devices a subnet holds besides the router", () => {
        expect(assist.hostCount("10.77.0.0/24")).toBe(253);
        expect(assist.hostCount("192.168.1.0/29")).toBe(5);
        expect(assist.hostCount("8.8.8.0/24")).toBeNull();
    });

    it("finds a device's network and a one-port machine", () => {
        expect(assist.networkOf([LAN], "10.77.0.50")?.id).toBe(LAN.id);
        expect(assist.networkOf([LAN], "10.78.0.50")).toBeNull();
        expect(assist.singleWiredPort(["ens6"])).toBe("ens6");
        expect(assist.singleWiredPort(["eth0", "eth1"])).toBeNull();
    });
});
