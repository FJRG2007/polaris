/**
 * Fixed and PPPoE lines, access points and IPv6: what each sends to a machine, what
 * stopping takes back, and that a password never lands where a plan is stored or shown.
 */

import * as router from "@/lib/router/plan";
import { describe, expect, it } from "vitest";
import { readProbe } from "@/lib/router/read";
import { refusalOf } from "@/lib/router/service";

const LAN_ID = "0190f1c2-0000-7000-8000-000000000001";
const LINE_ID = "0190f1c2-0000-7000-8000-000000000002";
const LAN = {
    id: LAN_ID,
    name: "Home",
    interface: "wlan0",
    vlan: null,
    cidr: "10.77.0.0/24",
    address: "10.77.0.1",
    internet: true,
    isolated: false,
    reservations: []
};
const WIFI = { ssid: "Casa ñ", country: "es", band: "5" as const };
const FIXED = {
    interface: "eth0",
    vlan: null,
    mode: "static" as const,
    address: "203.0.113.2/29",
    gateway: "203.0.113.1"
};
const SESSION = {
    interface: "eth0",
    vlan: 6,
    id: LINE_ID,
    mode: "pppoe" as const,
    username: "fixture@isp",
    password: 'fixture"pass\\word'
};
const ACCESS = { management: "192.0.2.9", sshPort: 22 };
const plan = (wans: unknown[], lans: unknown[] = [LAN]) =>
    router.routerPlanSchema.parse({ wans, lans, forwards: [] });
const issues = (wans: unknown[], lans: unknown[] = [LAN]) => {
    const result = router.routerPlanSchema.safeParse({ wans, lans, forwards: [] });
    return result.success ? [] : result.error.issues.map(({ message }) => message);
};

describe("a fixed line", () => {
    it("refuses a gateway outside its subnet and a subnet a network uses", () => {
        expect(issues([{ ...FIXED, gateway: "198.51.100.1" }])).toContain("badStaticLine");
        expect(issues([{ ...FIXED, address: "203.0.113.2" }])).toContain("badStaticLine");
        expect(issues([{ ...FIXED, gateway: "203.0.113.2" }])).toContain("badStaticLine");
        const near = [{ ...FIXED, address: "10.77.0.2/24", gateway: "10.77.0.3" }];
        expect(issues(near)).toContain("lineSubnet");
    });

    it("takes back only an address it added itself", () => {
        const fixed = plan([FIXED]);
        expect(router.renderLines(fixed)).toContain(
            "ip addr add 203.0.113.2/29 dev eth0 && : > /run/polaris-router/address.eth0"
        );
        expect(router.renderLines(fixed)).toContain(
            "ip route replace default via 203.0.113.1 dev eth0 metric 300"
        );
        expect(router.renderLines(fixed)).not.toContain("dhclient -4");
        expect(router.renderDown(fixed)).toContain(
            "if [ -f /run/polaris-router/address.eth0 ]; then ip addr del 203.0.113.2/29 dev eth0"
        );
    });

    it("is refused when Polaris logs in by the address it replaces", () => {
        const port = {
            name: "eth0",
            up: true,
            mac: null,
            addresses: ["192.0.2.5/24"],
            hasGateway: true,
            received: 0,
            sent: 0
        };
        const reading = {
            ports: [port, { ...port, name: "wlan0", addresses: [], wireless: true }],
            activeWan: null,
            running: false,
            clients: [],
            rolledBack: false
        };
        expect(refusalOf(plan([FIXED]), reading, "192.0.2.5")).toBe("lockout");
        expect(refusalOf(plan([FIXED]), reading, "198.51.100.7")).toBeNull();
    });
});

describe("a PPPoE line", () => {
    it("needs a user and something to name its password by", () => {
        expect(issues([{ ...SESSION, username: undefined }])).toContain("badPppoe");
        expect(issues([{ ...SESSION, id: undefined }])).toContain("badPppoe");
    });

    it("refuses a password that could end its line in the file", () => {
        expect(issues([{ ...SESSION, password: "a\nplugin evil.so" }]).length).toBeGreaterThan(0);
    });

    it("runs the session over the port and treats the session as the line", () => {
        const session = plan([SESSION]);
        const device = router.lineDevice(session.wans[0] ?? SESSION);
        expect(device).toBe("ppp-eth0.6");
        expect(device.length).toBeLessThanOrEqual(15);
        const lines = router.renderLines(session);
        expect(lines).toContain("nic-eth0.6");
        expect(lines).toContain(`ip route replace default dev ${device} metric 300`);
        const rules = router.renderFirewall(session, ACCESS);
        expect(rules).toContain(`oifname { "${device}" } meta nfproto ipv4 masquerade`);
        expect(rules).toContain("tcp flags syn tcp option maxseg size set rt mtu");
        expect(router.renderWanWatch(session)).toContain(`WANS="${device}"`);
    });

    it("quotes the sign-in and keeps it off every command line", () => {
        const session = plan([SESSION]);
        const wan = session.wans[0] ?? SESSION;
        expect(router.renderPppOptions(wan, 'a"b\\c', false)).toContain('password "a\\"b\\\\c"');
        expect(router.renderLines(session)).not.toContain("fixture");
        const script = router.renderApply(session, ACCESS, "id", { [LINE_ID]: "fixture-secret" });
        expect(script).toContain("(umask 077; cat > '/etc/polaris-router.next/ppp-ppp-eth0.6.conf'");
    });

    it("keeps its 15 characters on a USB adapter", () => {
        const device = router.lineDevice({ ...SESSION, interface: "enx00e04c680001", vlan: 2000 });
        expect(device.length).toBeLessThanOrEqual(15);
    });
});

describe("an access point", () => {
    const lans = [{ ...LAN, wifi: { ...WIFI, password: "fixture-wifi" } }];

    it("cannot sit on a VLAN and follows WPA2's password rule", () => {
        expect(issues([{ interface: "eth0", vlan: null }], [{ ...lans[0], vlan: 30 }])).toContain(
            "wifiVlan"
        );
        const short = [{ ...LAN, wifi: { ...WIFI, password: "short" } }];
        expect(issues([{ interface: "eth0", vlan: null }], short)).toContain("badWifi");
        const long = [{ ...LAN, wifi: { ...WIFI, ssid: "n".repeat(33) } }];
        expect(issues([{ interface: "eth0", vlan: null }], long)).toContain("badWifi");
    });

    it("writes the name in hex and starts only once", () => {
        const wifi = plan([{ interface: "eth0", vlan: null }], lans);
        const lan = wifi.lans[0];
        if (!lan) throw new Error("no network");
        const file = router.renderAccessPoint(lan, "fixture-wifi");
        expect(file).toContain("ssid2=43617361");
        expect(file).toContain("country_code=ES");
        expect(file).toContain("wpa=2");
        expect(file).not.toContain("Casa");
        expect(router.renderLines(wifi)).toContain(
            "if ! running /run/polaris-router/hostapd.wlan0.pid hostapd; then"
        );
    });

    it("is refused on a port with no radio, and waits for an unplugged one", () => {
        const wifi = plan([{ interface: "eth0", vlan: null }], lans);
        const port = {
            name: "eth0",
            up: true,
            mac: null,
            addresses: [],
            hasGateway: true,
            received: 0,
            sent: 0
        };
        const reading = {
            ports: [port, { ...port, name: "wlan0" }],
            activeWan: null,
            running: false,
            clients: [],
            rolledBack: false
        };
        expect(refusalOf(wifi, reading, "192.0.2.5")).toBe("notRadio");
        expect(refusalOf(wifi, { ...reading, ports: [port] }, "192.0.2.5", wifi)).toBeNull();
    });
});

describe("IPv6", () => {
    const lans = [{ ...LAN, interface: "eth1", ipv6: true }];
    const six = plan([{ interface: "eth0", vlan: null }], lans);

    it("is absent unless a network asks for it", () => {
        const plain = plan([{ interface: "eth0", vlan: null }], [{ ...LAN, interface: "eth1" }]);
        expect(router.renderDnsmasq(plain)).not.toContain("enable-ra");
        expect(router.renderUp(plain)).not.toContain("ipv6");
        expect(router.renderLines(plain)).not.toContain("dhcpcd");
    });

    it("asks the first line for a prefix and announces it on the network", () => {
        const client = router.renderPrefixClient(six);
        expect(client).toContain("interface eth0");
        expect(client).toContain("ia_pd 2 eth1/1/64");
        expect(client).toContain("script /bin/true");
        expect(router.renderDnsmasq(six)).toContain(
            "dhcp-range=::,constructor:eth1,ra-stateless,64,12h"
        );
    });

    it("keeps IPv6 out of address translation and lets DHCPv6 answers in", () => {
        const rules = router.renderFirewall(six, ACCESS);
        expect(rules).toContain("meta nfproto ipv4 masquerade");
        expect(rules).toContain('iifname { "eth0" } udp sport 547 udp dport 546 accept');
    });

    it("leaves forwarding as it found it", () => {
        expect(router.renderUp(six)).toContain(": > /run/polaris-router/ipv6-forwarding");
        expect(router.renderDown(six)).toContain("if [ -f /run/polaris-router/ipv6-forwarding ]");
    });

    it("keeps a network's link-local address through a restart", () => {
        expect(router.renderUp(six)).toContain("ip -4 addr flush dev eth1");
    });
});

describe("passwords", () => {
    const full = plan([SESSION], [{ ...LAN, wifi: { ...WIFI, password: "fixture-wifi" } }]);

    it("are gone from the plan that is stored and shown", () => {
        const stored = JSON.stringify(router.withoutSecrets(full));
        expect(stored).not.toContain("fixture-wifi");
        expect(stored).not.toContain("fixture\\\"pass");
        expect(router.readPlan(JSON.parse(stored))).not.toBeNull();
    });

    it("are taken from what was typed, or kept from before", () => {
        const stored = router.withoutSecrets(full);
        expect(router.secretsOf(stored, {})).toBeNull();
        expect(router.secretsOf(stored, { [LINE_ID]: "kept-line", [LAN_ID]: "kept-wifi1" })).toEqual({
            [LINE_ID]: "kept-line",
            [LAN_ID]: "kept-wifi1"
        });
        expect(router.secretsOf(full, { [LINE_ID]: "old", [LAN_ID]: "old-wifi1" })).toEqual({
            [LINE_ID]: SESSION.password,
            [LAN_ID]: "fixture-wifi"
        });
    });

    it("of a line that stopped using one are dropped", () => {
        const plain = plan([{ interface: "eth0", vlan: null }]);
        expect(router.secretsOf(plain, { [LINE_ID]: "old" })).toEqual({});
    });
});

describe("reading a machine", () => {
    it("tells radios, sessions and public addresses apart", () => {
        const reading = readProbe(
            [
                "---links",
                '[{"ifname":"eth0","operstate":"UP"},{"ifname":"wlan0","operstate":"UP"},{"ifname":"ppp-eth0","operstate":"UNKNOWN"}]',
                "---addresses",
                '[{"ifname":"ppp-eth0","addr_info":[{"local":"203.0.113.9","prefixlen":32}]}]',
                "---publicsix",
                '[{"ifname":"eth0","addr_info":[{"local":"2001:db8:1::1","prefixlen":64}]}]',
                "---radios",
                "wlan0",
                "---airing",
                "wlan0",
                "---routes",
                "[]",
                "---end"
            ].join("\n")
        );
        expect(reading.ports.map(({ name }) => name)).toEqual(["eth0", "wlan0"]);
        expect(reading.sessions).toEqual(["ppp-eth0"]);
        expect(reading.airing).toEqual(["wlan0"]);
        expect(reading.ports[1]?.wireless).toBe(true);
        expect(reading.ports[0]?.publicAddresses).toEqual(["2001:db8:1::1/64"]);
    });
});
