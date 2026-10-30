import { describe, expect, it } from "vitest";
import { generateKeyPair, slotAddresses } from "../../src/lib/deploy/wireguard/tunnel-config";
import {
    FRP_CONTROL_PORT,
    FRPC_IMAGE,
    FRPS_IMAGE,
    RELAY_LISTEN_PORT,
    RELAY_SLOT,
    frpToken,
    relayConfigs,
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

    it("renders the relay end: listens for the house only, forwards each port", () => {
        const text = renderRelayConfig(keys, webOnly);
        expect(text).toContain(`ListenPort = ${RELAY_LISTEN_PORT}`);
        expect(text).toContain(`PublicKey = ${keys.home.publicKey}`);
        expect(text).toContain(`AllowedIPs = ${peerAddress}/32`);
        expect(text).toContain(`BindAddress = 0.0.0.0:443\nTarget = ${peerAddress}:443`);
        expect(text.match(/\[TCPClientTunnel\]/g)).toHaveLength(2);
        // No UDP to carry: no way in for frp either.
        expect(text).not.toContain("[TCPServerTunnel]");
        expect(text).not.toContain(keys.home.privateKey);
    });

    it("renders the house end: dials out with a keepalive, hands ports to this machine", () => {
        const text = renderHomeConfig(keys, "198.51.100.20", { tcp: [80, 443, 25565], udp: [] });
        expect(text).toContain(`Endpoint = 198.51.100.20:${RELAY_LISTEN_PORT}`);
        expect(text).toContain("PersistentKeepalive = 25");
        expect(text).toContain(`AllowedIPs = ${publicAddress}/32`);
        expect(text).toContain("ListenPort = 25565\nTarget = host.docker.internal:25565");
        expect(text).not.toContain("[TCPClientTunnel]");
        expect(text).not.toContain(keys.relay.privateKey);
        expect(renderHomeConfig(keys, "2001:db8::1", webOnly)).toContain(
            `Endpoint = [2001:db8::1]:${RELAY_LISTEN_PORT}`
        );
    });

    it("joins frp's two halves through the link when there is UDP", () => {
        const relay = renderRelayConfig(keys, withUdp);
        expect(relay).toContain(
            `[TCPServerTunnel]\nListenPort = ${FRP_CONTROL_PORT}\nTarget = 127.0.0.1:${FRP_CONTROL_PORT}`
        );
        const home = renderHomeConfig(keys, "198.51.100.20", withUdp);
        expect(home).toContain(
            `[TCPClientTunnel]\nBindAddress = 127.0.0.1:${FRP_CONTROL_PORT}\nTarget = ${publicAddress}:${FRP_CONTROL_PORT}`
        );
    });

    it("renders frps: control on loopback, proxies public, only the carried ports allowed", () => {
        const text = renderRelayFrp(keys, withUdp.udp);
        expect(text).toContain('bindAddr = "127.0.0.1"');
        expect(text).toContain(`bindPort = ${FRP_CONTROL_PORT}`);
        expect(text).toContain('proxyBindAddr = "0.0.0.0"');
        expect(text).toContain("allowPorts = [{ single = 19132 }, { single = 25565 }]");
        expect(text).toContain(`auth.token = "${frpToken(keys)}"`);
        expect(text).not.toMatch(/kcpBindPort|quicBindPort|webServer/);
    });

    it("renders frpc: dials through the link, one UDP proxy per port to this machine", () => {
        const text = renderHomeFrp(keys, withUdp.udp);
        expect(text).toContain('serverAddr = "127.0.0.1"');
        expect(text).toContain(`serverPort = ${FRP_CONTROL_PORT}`);
        expect(text).toContain("loginFailExit = false");
        expect(text).toContain(`auth.token = "${frpToken(keys)}"`);
        expect(text.match(/\[\[proxies\]\]/g)).toHaveLength(2);
        expect(text).toContain(
            '[[proxies]]\nname = "udp-19132"\ntype = "udp"\nlocalIP = "host.docker.internal"\nlocalPort = 19132\nremotePort = 19132'
        );
    });

    it("derives one secret token both ends agree on, never a key", () => {
        expect(frpToken(keys)).toMatch(/^[0-9a-f]{64}$/);
        expect(frpToken(keys)).toBe(frpToken({ ...keys }));
        expect(frpToken({ relay: keys.relay, home: generateKeyPair() })).not.toBe(frpToken(keys));
        expect(renderHomeFrp(keys, [19132])).not.toContain(keys.home.privateKey);
    });

    it("refuses a value that would break a file", () => {
        expect(() => renderHomeConfig(keys, "198.51.100.20\nPostUp = x", webOnly)).toThrow();
        expect(() =>
            renderRelayConfig(
                { relay: { privateKey: "nope", publicKey: "nope" }, home: keys.home },
                webOnly
            )
        ).toThrow();
        expect(() => renderRelayFrp(keys, [RELAY_LISTEN_PORT])).toThrow();
        expect(() => renderHomeFrp(keys, [1.5])).toThrow();
        expect(() => renderRelayConfig(keys, { tcp: [0], udp: [] })).toThrow();
    });

    it("joins the edge's network on the relay end", () => {
        const configs = relayConfigs(keys, "198.51.100.20", webOnly);
        const relay = relaySpec("relay", configs.relay, webOnly, ["polaris-proxy"]);
        expect(relay.networks).toEqual(["polaris-proxy"]);
        expect(relay.services[0].networks).toEqual(["polaris-proxy"]);
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
        expect(relay.project).toBe(relayProject("relay"));
        expect(home.project).toBe(relayProject("home"));
        expect(relay.project).not.toBe(home.project);
    });

    it("runs frp in each end's namespace and publishes the UDP ports when there are any", () => {
        const configs = relayConfigs(keys, "198.51.100.20", withUdp);
        const relay = relaySpec("relay", configs.relay, withUdp);
        const [helper, , frps] = relay.services;
        expect(helper.ports.map((p) => `${p.host}/${p.protocol ?? "tcp"}`)).toEqual([
            `${RELAY_LISTEN_PORT}/udp`,
            "25565/tcp",
            "19132/udp",
            "25565/udp"
        ]);
        expect(frps.image).toBe(FRPS_IMAGE);
        expect(frps.networkMode).toBe(`service:${helper.name}`);
        expect(frps.ports).toEqual([]);
        expect(frps.command).toEqual(["-c", "/etc/wireproxy/frp.toml"]);
        expect(frps.volumes).toEqual(helper.volumes);
        // The helper writes the frp file beside the WireGuard one, and removes both.
        expect(Buffer.from(helper.env.WG_FILE_0 ?? "", "base64").toString("utf8")).toBe(
            configs.relay.frp
        );
        expect(helper.command?.join(" ")).toContain(
            "rm -f /etc/wireproxy/config /etc/wireproxy/frp.toml"
        );

        const home = relaySpec("home", configs.home, withUdp);
        const frpc = home.services[2];
        expect(frpc.image).toBe(FRPC_IMAGE);
        expect(frpc.networkMode).toBe(`service:${home.services[0].name}`);
        expect(home.services[0].ports).toEqual([]);
        // Nothing the daemon refuses: no capabilities, no host network, no newline.
        for (const service of [...relay.services, ...home.services]) {
            expect(service).not.toHaveProperty("capAdd");
            expect(service.networkMode ?? "").not.toBe("host");
            for (const value of [...Object.values(service.env), ...(service.command ?? [])])
                expect(value).not.toMatch(/[\u0000-\u001f]/);
        }
    });
});
