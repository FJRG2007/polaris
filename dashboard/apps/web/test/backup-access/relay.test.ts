import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateKeyPair, slotAddresses } from "../../src/lib/deploy/wireguard/tunnel-config";
import {
    FRP_CONTROL_PORT,
    FRPC_IMAGE,
    FRPS_IMAGE,
    RELAY_EDGE_ADDRESS,
    RELAY_EDGE_NETWORK,
    RELAY_LISTEN_PORT,
    RELAY_SLOT,
    frpToken,
    relayConfigs,
    relayFrp,
    relayHelper,
    relayPorts,
    relayProject,
    relaySpec,
    renderRelayRoutes,
    renderHomeConfig,
    renderHomeFrp,
    renderRelayConfig,
    renderRelayFrp
} from "../../src/lib/backup-access/relay";

const keys = { relay: generateKeyPair(), home: generateKeyPair() };
const { publicAddress, peerAddress } = slotAddresses(RELAY_SLOT);
const webOnly = { tcp: [80, 443], udp: [] };
const withUdp = { tcp: [80, 443, 25565], udp: [19132, 25565] };

describe("backup relay config", () => {
    it("carries the web ports and every game port, TCP and UDP", () => {
        const ports = relayPorts([
            { port: 25565, protocol: "tcp" },
            { port: 19132, protocol: "udp" },
            { port: 25565, protocol: "udp" },
            { port: 443, protocol: "tcp" },
            { port: 0, protocol: "tcp" },
            { port: 70000, protocol: "udp" },
            { port: RELAY_LISTEN_PORT, protocol: "tcp" },
            { port: RELAY_LISTEN_PORT, protocol: "udp" }
        ]);
        expect(ports).toEqual({ tcp: [80, 443, 25565], udp: [19132, 25565] });
        expect(relayPorts([])).toEqual(webOnly);
    });

    it("renders the relay end: listens for the house only, forwards the web ports", () => {
        const text = renderRelayConfig(keys);
        expect(text).toContain(`ListenPort = ${RELAY_LISTEN_PORT}`);
        expect(text).toContain(`PublicKey = ${keys.home.publicKey}`);
        expect(text).toContain(`AllowedIPs = ${peerAddress}/32`);
        expect(text).toContain(`BindAddress = 0.0.0.0:443\nTarget = ${peerAddress}:443`);
        expect(text.match(/\[TCPClientTunnel\]/g)).toHaveLength(2);
        expect(text).not.toContain("25565");
        expect(text).not.toContain(keys.home.privateKey);
    });

    it("renders the house end: dials out with a keepalive, hands the web ports to this machine", () => {
        const text = renderHomeConfig(keys, "198.51.100.20");
        expect(text).toContain(`Endpoint = 198.51.100.20:${RELAY_LISTEN_PORT}`);
        expect(text).toContain("PersistentKeepalive = 25");
        expect(text).toContain(`AllowedIPs = ${publicAddress}/32`);
        expect(text).toContain("ListenPort = 80\nTarget = host.docker.internal:80");
        expect(text).toContain(`ListenPort = 443\nTarget = ${RELAY_EDGE_ADDRESS}:443`);
        expect(text.match(/\[TCPServerTunnel\]/g)).toHaveLength(2);
        expect(text).not.toContain(keys.relay.privateKey);
        expect(renderHomeConfig(keys, "2001:db8::1")).toContain(
            `Endpoint = [2001:db8::1]:${RELAY_LISTEN_PORT}`
        );
    });

    it("joins frp's two halves through the link, frps found by name on the relay", () => {
        expect(renderRelayConfig(keys)).toContain(
            `[TCPServerTunnel]\nListenPort = ${FRP_CONTROL_PORT}\nTarget = ${relayFrp()}:${FRP_CONTROL_PORT}`
        );
        expect(renderHomeConfig(keys, "198.51.100.20")).toContain(
            `[TCPClientTunnel]\nBindAddress = 127.0.0.1:${FRP_CONTROL_PORT}\nTarget = ${publicAddress}:${FRP_CONTROL_PORT}`
        );
    });

    it("renders frps: control unpublished, proxies public, only the side ports allowed", () => {
        const text = renderRelayFrp(keys, withUdp);
        expect(text).toContain('bindAddr = "0.0.0.0"');
        expect(text).toContain(`bindPort = ${FRP_CONTROL_PORT}`);
        expect(text).toContain('proxyBindAddr = "0.0.0.0"');
        // 25565 is carried as TCP and UDP: one entry; the web ports never.
        expect(text).toContain("allowPorts = [{ single = 19132 }, { single = 25565 }]");
        expect(text).toContain(`auth.token = "${frpToken(keys)}"`);
        expect(text).not.toMatch(/kcpBindPort|quicBindPort|webServer/);
    });

    it("renders frpc: dials through the link, one proxy per side port to this machine", () => {
        const text = renderHomeFrp(keys, withUdp);
        expect(text).toContain('serverAddr = "127.0.0.1"');
        expect(text).toContain(`serverPort = ${FRP_CONTROL_PORT}`);
        expect(text).toContain("loginFailExit = false");
        expect(text).toContain(`auth.token = "${frpToken(keys)}"`);
        expect(text.match(/\[\[proxies\]\]/g)).toHaveLength(3);
        expect(text).toContain(
            '[[proxies]]\nname = "tcp-25565"\ntype = "tcp"\nlocalIP = "host.docker.internal"\nlocalPort = 25565\nremotePort = 25565'
        );
        expect(text).toContain(
            '[[proxies]]\nname = "udp-19132"\ntype = "udp"\nlocalIP = "host.docker.internal"\nlocalPort = 19132\nremotePort = 19132'
        );
        expect(text).not.toMatch(/name = "tcp-(80|443)"/);
    });

    it("hands UDP to the LAN address, where the call server listens, and TCP to the gateway", () => {
        const configs = relayConfigs(keys, "198.51.100.20", withUdp, "192.0.2.10");
        expect(configs.home.frp).toContain(
            'name = "udp-19132"\ntype = "udp"\nlocalIP = "192.0.2.10"'
        );
        expect(configs.home.frp).toContain(
            'name = "tcp-25565"\ntype = "tcp"\nlocalIP = "host.docker.internal"'
        );
    });
    it("derives one secret token both ends agree on, never a key", () => {
        expect(frpToken(keys)).toMatch(/^[0-9a-f]{64}$/);
        expect(frpToken(keys)).toBe(frpToken({ ...keys }));
        expect(frpToken({ relay: keys.relay, home: generateKeyPair() })).not.toBe(frpToken(keys));
        expect(renderHomeFrp(keys, { tcp: [], udp: [19132] })).not.toContain(keys.home.privateKey);
    });

    it("refuses a value that would break a file", () => {
        expect(() => renderHomeConfig(keys, "198.51.100.20\nPostUp = x")).toThrow();
        expect(() =>
            renderRelayConfig({ relay: { privateKey: "nope", publicKey: "nope" }, home: keys.home })
        ).toThrow();
        expect(() => renderRelayFrp(keys, { tcp: [], udp: [RELAY_LISTEN_PORT] })).toThrow();
        expect(() => renderHomeFrp(keys, { tcp: [], udp: [1.5] })).toThrow();
        expect(() => relayConfigs(keys, "198.51.100.20", { tcp: [0], udp: [] })).toThrow();
    });
    it("joins the edge's network on the relay end", () => {
        const configs = relayConfigs(keys, "198.51.100.20", webOnly);
        const relay = relaySpec("relay", configs.relay, webOnly, ["polaris-proxy"]);
        expect(relay.networks).toEqual(["polaris-proxy"]);
        // `default` is how the link reaches frps.
        expect(relay.services[0].networks).toEqual(["default", "polaris-proxy"]);
    });

    it("routes only the house's hostnames to the relay", () => {
        const yaml = renderRelayRoutes(["Polaris.example.com", "*.plr.example.com"]);
        expect(yaml).toContain(
            "rule: 'HostSNI(`polaris.example.com`) || HostSNIRegexp(`^.+[.]plr[.]example[.]com$`)'"
        );
        expect(yaml).toContain(
            "rule: 'Host(`polaris.example.com`) || HostRegexp(`^.+[.]plr[.]example[.]com$`)'"
        );
        expect(yaml).toContain("passthrough: true");
        expect(yaml).toMatch(/proxyProtocol:\n\s+version: 2/);
        expect(yaml).toContain(`address: "${relayHelper()}:443"`);
        expect(yaml).toContain(`url: "http://${relayHelper()}:80"`);
        expect(yaml).not.toContain("\\");
    });

    it("leaves the server's own apps under a house wildcard to its edge", () => {
        const yaml = renderRelayRoutes(
            ["polaris.example.com", "*.plr.example.com"],
            [
                "Shop.plr.example.com",
                "shop.plr.example.com",
                "shop.other.com",
                "polaris.example.com"
            ]
        );
        expect(yaml).toContain(
            "rule: '(HostSNI(`polaris.example.com`) || HostSNIRegexp(`^.+[.]plr[.]example[.]com$`)) && !(HostSNI(`shop.plr.example.com`))'"
        );
        expect(yaml).toContain(
            "rule: '(Host(`polaris.example.com`) || HostRegexp(`^.+[.]plr[.]example[.]com$`)) && !(Host(`shop.plr.example.com`))'"
        );
        expect(yaml).not.toContain("shop.other.com");
    });

    it("skips a stored name it could not route rather than failing the relay", () => {
        const yaml = renderRelayRoutes(["*.plr.example.com"], ["bad name.plr.example.com"]);
        expect(yaml).not.toContain("bad name");
    });

    it("refuses a name that could change the rule", () => {
        expect(() => renderRelayRoutes(["a.com`) || Host(`b.com"])).toThrow();
        expect(() => renderRelayRoutes(["a.com' #"])).toThrow();
    });

    it("publishes the carried ports on the relay end only", () => {
        const configs = relayConfigs(keys, "198.51.100.20", webOnly);
        expect(configs.relay.frp).toBeNull();
        expect(configs.home.frp).toBeNull();
        const relay = relaySpec("relay", configs.relay, webOnly);
        const ports = relay.services[0].ports.map((p) => `${p.host}/${p.protocol ?? "tcp"}`);
        // 80 and 443 belong to the server's edge, so the server can serve its own apps.
        expect(ports).toEqual([`${RELAY_LISTEN_PORT}/udp`]);
        expect(relay.services).toHaveLength(2);
        const home = relaySpec("home", configs.home, webOnly);
        expect(home.services[0].ports).toEqual([]);
        expect(home.services[0].extraHosts).toContain("host.docker.internal:host-gateway");
        // WireGuard's resolver never reads the hosts file the entry above lands in.
        const script = home.services[0].command?.[2] ?? "";
        expect(script).toContain("grep -F host.docker.internal /etc/hosts");
        expect(script).toContain('sed "s/host.docker.internal/${PINNED:-host.docker.internal}/g"');
        expect(relay.services[0].command?.[2]).not.toContain("PINNED");
        expect(home.services).toHaveLength(2);
        expect(home.services[0].networks).toEqual(["default", RELAY_EDGE_NETWORK]);
        expect(home.networks).toEqual([RELAY_EDGE_NETWORK]);
        expect(relay.services[0].networks).not.toContain(RELAY_EDGE_NETWORK);
        expect(relay.project).toBe(relayProject("relay"));
        expect(home.project).toBe(relayProject("home"));
        expect(relay.project).not.toBe(home.project);
    });

    it("lets only the house end state a visitor's address to the edge", () => {
        const compose = readFileSync(
            new URL("../../../../docker/docker-compose.yml", import.meta.url),
            "utf8"
        ).replaceAll("\r\n", "\n");
        expect(compose.match(/proxyprotocol\.trustedips=[^"]*/g)).toEqual([
            "proxyprotocol.trustedips=10.213.254.4/30"
        ]);
        expect(compose).toContain(
            `${RELAY_EDGE_NETWORK}:\n        ipv4_address: ${RELAY_EDGE_ADDRESS}\n`
        );
        expect(compose).toContain(
            [
                `  ${RELAY_EDGE_NETWORK}:`,
                `    name: ${RELAY_EDGE_NETWORK}`,
                "    internal: true",
                "    ipam:",
                "      config:",
                "        - subnet: 10.213.254.0/29",
                "          ip_range: 10.213.254.4/30"
            ].join("\n")
        );
    });

    it("runs frp in containers of its own, publishing the side ports on the relay end", () => {
        const configs = relayConfigs(keys, "198.51.100.20", withUdp);
        const relay = relaySpec("relay", configs.relay, withUdp, ["polaris-proxy"]);
        const [helper, , frps] = relay.services;
        // The link publishes only its own port, whatever is installed.
        expect(helper.ports.map((p) => `${p.host}/${p.protocol ?? "tcp"}`)).toEqual([
            `${RELAY_LISTEN_PORT}/udp`
        ]);
        expect(frps.name).toBe(relayFrp());
        expect(frps.image).toBe(FRPS_IMAGE);
        expect(frps.networkMode).toBeUndefined();
        expect(frps.networks).toEqual(["default"]);
        expect(frps.dependsOn).toEqual([helper.name]);
        expect(frps.ports.map((p) => `${p.host}/${p.protocol ?? "tcp"}`)).toEqual([
            "25565/tcp",
            "19132/udp",
            "25565/udp"
        ]);
        expect(frps.entrypoint).toEqual(["sh", "-c"]);
        expect(frps.command?.[0]).toContain("exec /usr/bin/frps -c /tmp/frp.toml");
        expect(frps.command?.[0]).not.toContain("PINNED");
        expect(Buffer.from(frps.env.FRP_CONFIG ?? "", "base64").toString("utf8")).toBe(
            configs.relay.frp
        );
        // The frp files no longer pass through the link's helper.
        expect(Object.keys(helper.env)).toEqual(["WG_CONFIG"]);
        // Only the edge's network is declared; `default` is the project's own.
        expect(relay.networks).toEqual(["polaris-proxy"]);

        const home = relaySpec("home", configs.home, withUdp);
        const frpc = home.services[2];
        expect(frpc.image).toBe(FRPC_IMAGE);
        expect(frpc.networkMode).toBe(`service:${home.services[0].name}`);
        expect(frpc.networks).toEqual([]);
        expect(frpc.ports).toEqual([]);
        expect(frpc.command?.[0]).toContain("grep -F host.docker.internal /etc/hosts");
        expect(frpc.command?.[0]).toContain("exec /usr/bin/frpc -c /tmp/frp.toml");
        expect(home.services[0].ports).toEqual([]);
        // Nothing the daemon refuses: no capabilities, no host network, no newline, and
        // nothing of its own on a service that shares another's network.
        for (const service of [...relay.services, ...home.services]) {
            expect(service).not.toHaveProperty("capAdd");
            expect(service.networkMode ?? "").not.toBe("host");
            for (const value of [
                ...Object.values(service.env),
                ...(service.command ?? []),
                ...(service.entrypoint ?? [])
            ])
                expect(value).not.toMatch(/[\u0000-\u001f]/);
            if (service.networkMode) {
                expect(service.networks).toEqual([]);
                expect(service.ports).toEqual([]);
                expect(service.extraHosts ?? []).toEqual([]);
            }
        }
    });

    it("adding or removing a game server leaves the link's containers exactly as they were", () => {
        // Compose recreates only what changed, so a link that renders the same is never
        // restarted - and the web, which rides it, never drops.
        const sets = [
            webOnly,
            withUdp,
            { tcp: [80, 443, 25565, 25566], udp: [19132, 25565, 50000] },
            { tcp: [80, 443], udp: [7882] }
        ];
        for (const end of ["relay", "home"] as const) {
            const links = sets.map((set) => {
                const configs = relayConfigs(keys, "198.51.100.20", set, "192.0.2.10");
                const spec = relaySpec(end, configs[end], set, ["polaris-proxy"]);
                return JSON.stringify(spec.services.slice(0, 2));
            });
            expect(new Set(links).size).toBe(1);
        }
    });
});
