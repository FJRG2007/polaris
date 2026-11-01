import { describe, expect, it } from "vitest";
import { vpnPolicy } from "@/lib/vpn/settings";
import * as networks from "@/lib/vpn/networks";

const NETWORK: networks.PrivateNetwork = {
    id: "0190f1c2-0000-7000-8000-000000000001",
    name: "Fixture home",
    cidr: "10.77.0.0/24",
    routerAddress: "10.77.0.1",
    targetId: "target-1",
    targetOwnerId: "owner-1",
    ssid: "Fixture's wifi",
    wifiPassword: "sealed",
    access: "admins",
    internet: false,
    createdAt: "2026-11-01T00:00:00.000Z"
};

describe("subnet rules", () => {
    it("clears host bits and keeps what it cannot read for the rule to refuse", () => {
        expect(networks.normalizeCidr(" 10.77.0.9/24 ")).toBe("10.77.0.0/24");
        expect(networks.normalizeCidr("not a subnet")).toBe("not a subnet");
    });

    it.each([
        ["10.77.0.0/24", true],
        ["192.168.50.0/24", true],
        ["10.0.0.0/16", true],
        ["10.0.0.0/8", false],
        ["10.77.0.0/30", false],
        ["172.16.0.0/24", false],
        ["8.8.8.0/24", false],
        ["100.64.0.0/24", false],
        ["10.77.0.0", false],
        ["10.77.0.0/24/1", false],
        ["10.77.300.0/24", false],
        ["", false]
    ])("%s usable: %s", (cidr, usable) => {
        expect(networks.isUsableCidr(cidr)).toBe(usable);
    });

    it("sees an overlap in either direction, and none between neighbours", () => {
        expect(networks.cidrsOverlap("10.77.0.0/16", "10.77.5.0/24")).toBe(true);
        expect(networks.cidrsOverlap("10.77.5.0/24", "10.77.0.0/16")).toBe(true);
        expect(networks.cidrsOverlap("10.77.0.0/24", "10.77.1.0/24")).toBe(false);
    });

    it("takes a host, not an end of the range or an outsider", () => {
        expect(networks.isHostOf("10.77.0.0/24", "10.77.0.1")).toBe(true);
        expect(networks.isHostOf("10.77.0.0/24", "10.77.0.0")).toBe(false);
        expect(networks.isHostOf("10.77.0.0/24", "10.77.0.255")).toBe(false);
        expect(networks.isHostOf("10.77.0.0/24", "10.77.1.1")).toBe(false);
        expect(networks.firstHost("10.77.0.0/24")).toBe("10.77.0.1");
    });

    it("suggests the first free block", () => {
        expect(networks.suggestCidr([])).toBe("10.77.0.0/24");
        expect(networks.suggestCidr(["10.77.0.0/24", "10.77.1.0/24"])).toBe("10.77.2.0/24");
    });

    it("keeps a DHCP pool inside the subnet at both ends of the sizes allowed", () => {
        expect(networks.dhcpPool("10.77.0.0/24")).toEqual({ start: 100, limit: 150 });
        const small = networks.dhcpPool("10.77.0.0/29");
        expect(small.start + small.limit).toBeLessThanOrEqual(6);
        expect(small.limit).toBeGreaterThan(0);
    });

    it.each([
        ["10.77.0.0/24", "10.77.0.100", "10.77.0.249"],
        ["10.77.0.128/25", "10.77.0.192", "10.77.0.253"],
        ["10.77.2.0/23", "10.77.2.100", "10.77.2.249"],
        ["10.77.0.0/29", "10.77.0.4", "10.77.0.5"]
    ])("spells the pool of %s as addresses", (cidr, first, last) => {
        expect(networks.dhcpRange(cidr)).toEqual({ first, last });
    });
});

describe("what is typed", () => {
    const input = {
        name: " Home ",
        cidr: "10.77.0.9/24",
        routerAddress: " 10.77.0.1 ",
        targetId: "target-1",
        ssid: "Home",
        access: "admins",
        internet: false
    };

    it("normalizes before it validates", () => {
        const parsed = networks.networkInputSchema.parse(input);
        expect(parsed).toMatchObject({
            name: "Home",
            cidr: "10.77.0.0/24",
            routerAddress: "10.77.0.1"
        });
    });

    it("refuses a router outside the subnet and an unusable subnet", () => {
        expect(
            networks.networkInputSchema.safeParse({ ...input, routerAddress: "10.78.0.1" }).success
        ).toBe(false);
        expect(
            networks.networkInputSchema.safeParse({ ...input, cidr: "172.17.0.0/24" }).success
        ).toBe(false);
    });
});

describe("a stored row", () => {
    it("keeps the entries it can read and drops only the broken one", () => {
        expect(networks.readNetworks([NETWORK, { id: "broken" }])).toEqual([NETWORK]);
        expect(networks.readNetworks(undefined)).toEqual([]);
        expect(networks.readNetworks("nonsense")).toEqual([]);
    });
});

describe("the access policy", () => {
    it("opens only shared networks to every user", () => {
        const list = [NETWORK, { ...NETWORK, cidr: "10.77.1.0/24", access: "everyone" as const }];
        expect(networks.sharedCidrs(list)).toEqual(["10.77.1.0/24"]);
        const policy = JSON.parse(vpnPolicy(["admin@"], networks.sharedCidrs(list)));
        expect(policy.grants).toContainEqual({
            src: ["autogroup:member"],
            dst: ["10.77.1.0/24"],
            ip: ["*"]
        });
        expect(JSON.stringify(policy)).not.toContain("10.77.0.0/24");
    });

    it("writes the policy it always did when nothing is shared", () => {
        expect(vpnPolicy(["admin@"], [])).toBe(vpnPolicy(["admin@"]));
    });
});

describe("the gateway", () => {
    it("runs unprivileged and offers every route as one device", () => {
        const spec = networks.gatewaySpec({
            name: networks.gatewayName("TARGET-1"),
            loginServer: "https://vpn.example.test",
            routes: ["10.77.0.0/24", "10.77.1.0/24"],
            authKey: "fixture-key",
            generation: null
        });
        const [service] = spec.services;
        expect(service?.env).toMatchObject({
            TS_USERSPACE: "true",
            TS_AUTH_ONCE: "true",
            TS_HOSTNAME: "polaris-gateway-target1",
            TS_ROUTES: "10.77.0.0/24,10.77.1.0/24",
            TS_EXTRA_ARGS: "--login-server=https://vpn.example.test"
        });
        expect(service?.ports).toEqual([]);
    });

    it("asks for empty state only when told, and only once per generation", () => {
        const spec = networks.gatewaySpec({
            name: "polaris-gateway-target1",
            loginServer: "https://vpn.example.test",
            routes: ["10.77.0.0/24"],
            authKey: "fixture-key",
            generation: "generation-1"
        });
        const [service] = spec.services;
        expect(service?.env.POLARIS_GENERATION).toBe("generation-1");
        expect(service?.entrypoint?.[2]).toContain('grep -qx "$POLARIS_GENERATION"');
        expect(service?.entrypoint?.[2]).toContain("exec /usr/local/bin/containerboot");
        expect(service?.entrypoint?.[2]).not.toMatch(/[\x00-\x1f]/);
    });

    it("is found again under the suffix a taken name gets, and never by name alone", () => {
        const name = "polaris-gateway-target1";
        const tag = "tag:polaris";
        expect(networks.isGatewayNode({ name, givenName: name, tags: [tag] }, name, tag)).toBe(
            true
        );
        expect(networks.isGatewayNode({ name, givenName: "renamed", tags: [tag] }, name, tag)).toBe(
            true
        );
        expect(
            networks.isGatewayNode({ name, givenName: `${name}-ab12`, tags: [tag] }, name, tag)
        ).toBe(true);
        expect(networks.isGatewayNode({ name, givenName: name, tags: [] }, name, tag)).toBe(false);
        expect(
            networks.isGatewayNode({ name: "laptop", givenName: "laptop", tags: [tag] }, name, tag)
        ).toBe(false);
    });
});

describe("a Wi-Fi name", () => {
    it("is measured in bytes and shortened without cutting a character", () => {
        expect(networks.ssidFrom("a".repeat(40))).toBe("a".repeat(32));
        expect(networks.ssidFrom("ñ".repeat(20))).toBe("ñ".repeat(16));
        expect(networks.ssidFrom(`${"a".repeat(31)}ñ`)).toBe("a".repeat(31));
    });
});

describe("the OpenWrt setup", () => {
    it("quotes what was typed so it cannot leave its value", () => {
        const script = networks.renderOpenWrtSetup(NETWORK, "fixture$(reboot)");
        expect(script).toContain(`ssid="'Fixture'"'"'s wifi'`);
        expect(script).toContain(`key="'fixture$(reboot)'`);
    });

    it("keeps a name on its comment line", () => {
        const script = networks.renderOpenWrtSetup({ ...NETWORK, name: "a\nreboot" }, "fixture");
        expect(script).toContain("# Polaris private network: a reboot");
        expect(script).not.toMatch(/^reboot$/m);
    });

    it("gives devices the internet only when the network allows it", () => {
        const id = "pn0190f1";
        expect(networks.renderOpenWrtSetup(NETWORK, "fixture")).not.toContain(
            `${id}_wan=forwarding`
        );
        expect(networks.renderOpenWrtSetup({ ...NETWORK, internet: true }, "fixture")).toContain(
            `${id}_wan=forwarding`
        );
    });

    it("keeps the bridge up with nothing on it, under the name the screen gives", () => {
        const script = networks.renderOpenWrtSetup(NETWORK, "fixture");
        const bridge = networks.bridgeName(NETWORK.id);
        expect(script).toContain(`_dev.name='${bridge}'`);
        expect(script).toContain("_dev.bridge_empty='1'");
    });

    it("turns a radio on only with its other networks off", () => {
        const script = networks.renderOpenWrtSetup(NETWORK, "fixture");
        const closed = script.indexOf('uci set "wireless.$iface.disabled=1"');
        const opened = script.indexOf('uci delete "wireless.$radio.disabled"');
        expect(closed).toBeGreaterThan(-1);
        expect(opened).toBeGreaterThan(closed);
    });

    it("uses names OpenWrt accepts: a zone of 11 characters, a device of 15", () => {
        const script = networks.renderOpenWrtSetup(NETWORK, "fixture");
        const zone = /firewall\.(\w+)\.name='(\w+)'/.exec(script)?.[2] ?? "";
        const device = /_dev\.name='([\w-]+)'/.exec(script)?.[1] ?? "";
        expect(zone.length).toBeLessThanOrEqual(11);
        expect(device.length).toBeLessThanOrEqual(15);
    });
});
