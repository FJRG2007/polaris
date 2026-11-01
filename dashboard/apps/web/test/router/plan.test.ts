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
const ENGINE = '{ "docker0", "br-*", "tailscale0" }';
const parsed = (plan: unknown) => router.routerPlanSchema.parse(plan);

describe("a router plan", () => {
    it("makes an id the schema takes without a secure context", () => {
        const id = router.newLanId();
        expect(router.lanSchema.safeParse({ ...LAN, id }).success).toBe(true);
        expect(id).not.toBe(router.newLanId());
    });

    it("says what is wrong with each refused part", () => {
        const issues = (plan: unknown) => {
            const result = router.routerPlanSchema.safeParse(plan);
            return result.success ? [] : result.error.issues.map(({ message }) => message);
        };
        expect(issues({ ...PLAN, wans: [] })).toContain("noLine");
        expect(issues({ ...PLAN, lans: [] })).toContain("noNetwork");
        expect(issues({ ...PLAN, wans: [{ interface: "eth0", vlan: 1 }] })).toContain("badVlan");
        expect(issues({ ...PLAN, wans: [{ interface: "eth0.20", vlan: null }] })).toContain(
            "badPort"
        );
        expect(router.isPortName("eth0.20")).toBe(false);
    });

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
        expect(rules).toContain('iifname { "eth1", "eth0" } tcp dport 22 drop');
    });

    it("cuts a confined network off from containers and the tailnet first", () => {
        for (const change of [{ isolated: true }, { internet: false }]) {
            const lans = [{ ...LAN, ...change }];
            const rules = router.renderFirewall(parsed({ ...PLAN, lans }), ACCESS);
            const forward = rules.slice(rules.indexOf("chain forward"));
            const drop = forward.indexOf(`iifname { "eth1" } oifname ${ENGINE} drop`);
            expect(drop).toBeGreaterThan(-1);
            expect(drop).toBeLessThan(forward.indexOf("ct status dnat accept"));
            expect(drop).toBeLessThan(forward.indexOf(`oifname ${ENGINE} accept`));
        }
        const open = router.renderFirewall(parsed(PLAN), ACCESS);
        expect(open).not.toContain(`oifname ${ENGINE} drop`);
    });

    it("keeps the login shut from a line, even to a private source, and open to Polaris", () => {
        const rules = router.renderFirewall(parsed(PLAN), ACCESS);
        const shut = rules.indexOf('iifname { "eth0" } tcp dport 22 drop');
        expect(shut).toBeGreaterThan(rules.indexOf("ip saddr 192.0.2.9 tcp dport 22 accept"));
        expect(shut).toBeLessThan(rules.indexOf("ip saddr { 10.0.0.0/8"));
    });
});

describe("a machine running Docker", () => {
    it("lets through what the router joins, both ways, and takes it away again", () => {
        const up = router.renderUp(parsed(PLAN));
        expect(up).toContain("iptables -w -n -L DOCKER-USER");
        expect(up).toContain("for from in eth1; do for to in eth1 eth0;");
        expect(up).toContain("for from in eth0; do for to in eth1;");
        expect(up.indexOf("DOCKER-USER")).toBeGreaterThan(up.indexOf("nft -f"));
        const down = router.renderDown(parsed(PLAN));
        expect(down).toContain("iptables -w -D DOCKER-USER -j POLARIS-ROUTER");
        expect(down).toContain("iptables -w -X POLARIS-ROUTER");
    });
});

describe("a line on a VLAN", () => {
    const tagged = parsed({ ...PLAN, wans: [{ interface: "eth0", vlan: 20 }] });

    it("asks for its own address, since nothing else on the machine will", () => {
        const lines = router.renderLines(tagged);
        expect(lines).toContain("name eth0.20 type vlan id 20");
        expect(lines.indexOf("dhclient -4 -nw")).toBeGreaterThan(
            lines.indexOf("ip link set eth0.20 up")
        );
        expect(lines).toContain("/var/lib/dhcp/dhclient.eth0.20.leases eth0.20");
        expect(router.renderApply(tagged, ACCESS, "id")).toContain('need="$need isc-dhcp-client"');
    });

    it("does not fail a plain line's change over the address client", () => {
        const apply = router.renderApply(parsed(PLAN), ACCESS, "id");
        expect(apply).not.toContain('need="$need isc-dhcp-client"');
        expect(apply).toContain("install -y -qq isc-dhcp-client; } >/dev/null 2>&1 || true");
    });
});

describe("applying", () => {
    it("arms the way back before the network is touched", () => {
        const script = router.renderApply(parsed(PLAN), ACCESS, "id");
        const armed = script.indexOf("--unit=polaris-router-rollback");
        expect(armed).toBeGreaterThan(-1);
        expect(armed).toBeLessThan(script.indexOf("--unit=polaris-router-activate"));
        expect(script.indexOf("nft -c -f")).toBeLessThan(armed);
    });
});

describe("what is refused before anything is sent", () => {
    const reading = {
        ports: [
            {
                name: "eth0",
                up: true,
                mac: null,
                addresses: ["192.168.1.5/24"],
                hasGateway: true,
                received: 0,
                sent: 0
            },
            {
                name: "eth1",
                up: true,
                mac: null,
                addresses: ["192.168.2.5/24"],
                hasGateway: false,
                received: 0,
                sent: 0
            }
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
    it("stops at the most leases a screen is sent", () => {
        const lease = "1700000000 aa:bb:cc:00:00:01 10.77.0.100 plug *";
        const leases = Array<string>(router.MAX_CLIENTS + 5).fill(lease);
        const reading = readProbe(["---leases", ...leases, "---end"].join("\n"));
        expect(reading.clients).toHaveLength(router.MAX_CLIENTS);
    });

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

describe("a port that is not there", () => {
    const backup = parsed({
        ...PLAN,
        wans: [
            { interface: "eth0", vlan: null },
            { interface: "enx00e04c680001", vlan: null }
        ]
    });

    it("stops no other part of the router", () => {
        const up = router.renderUp(backup);
        const lines = router.renderLines(backup);
        expect(lines).toContain("if ip link show enx00e04c680001 >/dev/null 2>&1; then");
        expect(lines).not.toContain("set -e");
        expect(up).toContain("if ip link show eth1 >/dev/null 2>&1; then");
        expect(router.renderDnsmasq(backup)).toContain("bind-dynamic");
        expect(router.renderDnsmasq(backup)).not.toContain("bind-interfaces");
    });

    it("forwards only once the firewall is in place", () => {
        const up = router.renderUp(backup);
        expect(up.indexOf("net.ipv4.ip_forward=1")).toBeGreaterThan(up.indexOf("nft -f"));
    });

    it("joins when plugged in, and a port with no address asks for one", () => {
        expect(router.renderWanWatch(backup)).toContain("/etc/polaris-router/lines.sh");
        expect(router.renderLines(backup)).toContain(
            'if [ -z "$(ip -4 -o addr show dev enx00e04c680001)" ]'
        );
    });
});

describe("a fixed address", () => {
    const fixed = (reservations: unknown[]) =>
        router.lanSchema.safeParse({ ...LAN, reservations }).success;
    const one = { mac: "aa:bb:cc:dd:ee:01", address: "10.77.0.10" };

    it("takes one address per device", () => {
        expect(fixed([one])).toBe(true);
        expect(fixed([one, { mac: "aa:bb:cc:dd:ee:02", address: one.address }])).toBe(false);
        expect(fixed([one, { mac: one.mac, address: "10.77.0.11" }])).toBe(false);
    });

    it("cannot be the router's own", () => {
        expect(fixed([{ ...one, address: LAN.address }])).toBe(false);
    });
});

describe("a change a restart interrupted", () => {
    it("is undone at boot, by a unit that outlives the timer", () => {
        const apply = router.renderApply(parsed(PLAN), ACCESS, "id");
        expect(apply).toContain("ConditionPathExists=/var/lib/polaris-router/unconfirmed");
        expect(apply).toContain("systemctl enable polaris-router-undo.service");
        expect(apply.indexOf("enable polaris-router-undo")).toBeLessThan(
            apply.indexOf("--unit=polaris-router-activate")
        );
    });
});

describe("stopping the router", () => {
    it("leaves nothing for the screen to keep reporting", () => {
        expect(router.REMOVE_SCRIPT).toContain("/var/lib/polaris-router/last");
        expect(router.REMOVE_SCRIPT).toContain("/run/polaris-router/wan");
        expect(router.REMOVE_SCRIPT).toContain("polaris-router-undo.service");
        expect(router.renderDown(parsed(PLAN))).toContain("rm -f /run/polaris-router/wan");
    });
});
