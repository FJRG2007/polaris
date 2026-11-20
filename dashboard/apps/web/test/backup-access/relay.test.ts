import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPrivateKey, createPublicKey } from "node:crypto";
import {
    WIREGUARD_IMAGE,
    endNames,
    generateKeyPair,
    isWireguardKey,
    slotAddresses
} from "../../src/lib/deploy/wireguard/tunnel-config";
import {
    NESTED_OVERHEAD,
    RELAY_EDGE_ADDRESS,
    RELAY_EDGE_NETWORK,
    RELAY_LISTEN_PORT,
    RELAY_MTU,
    RELAY_SIDE_SLOT,
    RELAY_CALL_SLOT,
    CALL_WIRE_PORT,
    RELAY_SLOT,
    RELAY_SPEC,
    SIDE_MTU,
    SIDE_WIRE_PORT,
    relayConfigs,
    relayHelper,
    relayPorts,
    relayProject,
    relaySide,
    relayCall,
    renderCallHomeConfig,
    renderCallRelayConfig,
    relaySpec,
    renderRelayRoutes,
    renderHomeConfig,
    renderRelayConfig,
    renderSideHomeConfig,
    renderSideRelayConfig,
    sideKeys
} from "../../src/lib/backup-access/relay";

/** The config a container gets, as its helper decodes it. */
function decoded(service: { env: Record<string, string> }): string {
    return Buffer.from(service.env.WG_CONFIG ?? "", "base64").toString("utf8");
}

/** Every forward section of a config, as `section port`. */
function forwards(text: string): string[] {
    const out: string[] = [];
    let section = "";
    for (const line of text.split("\n")) {
        if (line.startsWith("[")) section = line;
        const port = /^(?:BindAddress = [^:]+:|ListenPort = )(\d+)$/.exec(line)?.[1];
        if (port && section !== "[Interface]") out.push(`${section} ${port}`);
    }
    return out;
}

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

    it("nests the side link inside the web link through one constant UDP forward", () => {
        const side = slotAddresses(RELAY_SIDE_SLOT);
        expect(renderRelayConfig(keys)).toContain(
            `[UDPServerTunnel]\nListenPort = ${SIDE_WIRE_PORT}\nTarget = ${relaySide()}:${SIDE_WIRE_PORT}`
        );
        expect(renderHomeConfig(keys, "198.51.100.20")).toContain(
            `[UDPProxyTunnel]\nBindAddress = 0.0.0.0:${SIDE_WIRE_PORT}\nTarget = ${publicAddress}:${SIDE_WIRE_PORT}`
        );
        const relaySideText = renderSideRelayConfig(keys, withUdp);
        expect(relaySideText).toContain(`ListenPort = ${SIDE_WIRE_PORT}`);
        expect(relaySideText).toContain(`Address = ${side.publicAddress}/32`);
        const homeSide = renderSideHomeConfig(keys, withUdp);
        // The house's side end dials the web link's forward, never the relay's address.
        expect(homeSide).toContain(
            `Endpoint = ${endNames("000000backup", "nat").helper}:${SIDE_WIRE_PORT}`
        );
        expect(homeSide).not.toContain("198.51.100.20");
        expect(homeSide).toContain("PersistentKeepalive = 25");
        expect(homeSide).toContain(`AllowedIPs = ${side.publicAddress}/32`);
        // No new public port: the side relay's port is never published.
        const configs = relayConfigs(keys, "198.51.100.20", withUdp);
        const relay = relaySpec("relay", configs.relay, withUdp, ["polaris-proxy"]);
        const published = relay.services.flatMap((service) =>
            service.ports.map((p) => `${p.host}/${p.protocol ?? "tcp"}`)
        );
        expect(published.filter((p) => p === `${SIDE_WIRE_PORT}/udp`)).toEqual([
            `${RELAY_LISTEN_PORT}/udp`
        ]);
        expect(SIDE_WIRE_PORT).toBe(RELAY_LISTEN_PORT);
    });

    it("sets the side link's MTU so a wrapped side packet is exactly one web link packet", () => {
        expect(NESTED_OVERHEAD).toBe(20 + 8 + 32);
        expect(RELAY_MTU).toBe(1420);
        // The web link's own MTU fits a 1500-byte path over IPv6: 1500 - 40 - 8 - 32.
        expect(1500 - 40 - 8 - 32).toBe(RELAY_MTU);
        expect(SIDE_MTU).toBe(1360);
        expect(SIDE_MTU % 16).toBe(0);
        // A full side packet plus WireGuard's 32 bytes is the largest datagram one web
        // link packet carries over its IPv4 addresses.
        expect(SIDE_MTU + 32).toBe(RELAY_MTU - 20 - 8);
        expect(renderRelayConfig(keys)).toContain(`MTU = ${RELAY_MTU}`);
        expect(renderHomeConfig(keys, "198.51.100.20")).toContain(`MTU = ${RELAY_MTU}`);
        expect(renderSideRelayConfig(keys, withUdp)).toContain(`MTU = ${SIDE_MTU}`);
        expect(renderSideHomeConfig(keys, withUdp)).toContain(`MTU = ${SIDE_MTU}`);
        // The link's addresses are IPv4, so the IPv4 overhead is the one that applies.
        expect(publicAddress).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
        expect(slotAddresses(RELAY_SIDE_SLOT).peerAddress).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    });

    it("carries every side port natively: UDP as UDP and TCP as TCP, none on a TCP path", () => {
        const relaySideText = renderSideRelayConfig(keys, withUdp);
        const homeSide = renderSideHomeConfig(keys, withUdp, "192.0.2.10");
        const { peerAddress: sidePeer } = slotAddresses(RELAY_SIDE_SLOT);
        expect(forwards(relaySideText)).toEqual([
            "[TCPClientTunnel] 25565",
            "[UDPProxyTunnel] 19132",
            "[UDPProxyTunnel] 25565"
        ]);
        expect(forwards(homeSide)).toEqual([
            "[TCPServerTunnel] 25565",
            "[UDPServerTunnel] 19132",
            "[UDPServerTunnel] 25565"
        ]);
        expect(relaySideText).toContain(
            `[UDPProxyTunnel]\nBindAddress = 0.0.0.0:19132\nTarget = ${sidePeer}:19132`
        );
        // No UDP port anywhere rides a TCP section, on any end, link or config.
        const sets = [withUdp, { tcp: [80, 443], udp: [7882, 50000, 51820] }];
        for (const set of sets) {
            const configs = relayConfigs(keys, "198.51.100.20", set, "192.0.2.10");
            const texts = [
                configs.relay.wireguard,
                configs.home.wireguard,
                configs.relay.side ?? "",
                configs.home.side ?? ""
            ];
            for (const text of texts)
                for (const entry of forwards(text)) {
                    const [section, port] = entry.split(" ");
                    if (section?.startsWith("[TCP")) {
                        const udpOnly = set.udp.filter((u) => !set.tcp.includes(u));
                        expect(udpOnly).not.toContain(Number(port));
                    }
                }
            // Nothing of the old TCP-carried path is left in any file.
            expect(texts.join("\n")).not.toMatch(/proxies|remotePort|serverPort/i);
        }
    });

    it("hands UDP to the LAN address, where the call server listens, and TCP to the gateway", () => {
        const configs = relayConfigs(keys, "198.51.100.20", withUdp, "192.0.2.10");
        expect(configs.home.side).toContain("[UDPServerTunnel]\nListenPort = 19132\nTarget = 192.0.2.10:19132");
        expect(configs.home.side).toContain(
            "[TCPServerTunnel]\nListenPort = 25565\nTarget = host.docker.internal:25565"
        );
        expect(renderSideHomeConfig(keys, withUdp, "fd00::10")).toContain(
            "Target = [fd00::10]:19132"
        );
    });

    it("derives the side link's keys from the web link's, both ends agreeing, never a stored key", () => {
        const side = sideKeys(keys);
        expect(side).toEqual(sideKeys({ ...keys }));
        for (const pair of [side.relay, side.home]) {
            expect(isWireguardKey(pair.privateKey)).toBe(true);
            expect(isWireguardKey(pair.publicKey)).toBe(true);
        }
        expect(side.relay.privateKey).not.toBe(keys.relay.privateKey);
        expect(side.home.privateKey).not.toBe(keys.home.privateKey);
        expect(side.relay.privateKey).not.toBe(side.home.privateKey);
        expect(sideKeys({ relay: keys.relay, home: generateKeyPair() }).home).not.toEqual(side.home);
        // Each public key is its private key's: the pairs are real X25519 pairs.
        const publicOf = (privateKey: string) =>
            Buffer.from(
                createPublicKey(
                    createPrivateKey({
                        key: Buffer.concat([
                            Buffer.from("302e020100300506032b656e04220420", "hex"),
                            Buffer.from(privateKey, "base64")
                        ]),
                        format: "der",
                        type: "pkcs8"
                    })
                ).export({ format: "jwk" }).x ?? "",
                "base64url"
            ).toString("base64");
        expect(publicOf(side.relay.privateKey)).toBe(side.relay.publicKey);
        expect(publicOf(side.home.privateKey)).toBe(side.home.publicKey);
        // Each end holds its own private key and the other's public key, nothing more.
        const relaySideText = renderSideRelayConfig(keys, withUdp);
        expect(relaySideText).toContain(`PrivateKey = ${side.relay.privateKey}`);
        expect(relaySideText).toContain(`PublicKey = ${side.home.publicKey}`);
        expect(relaySideText).not.toContain(side.home.privateKey);
        const homeSide = renderSideHomeConfig(keys, withUdp);
        expect(homeSide).toContain(`PrivateKey = ${side.home.privateKey}`);
        expect(homeSide).not.toContain(side.relay.privateKey);
        for (const text of [relaySideText, homeSide]) {
            expect(text).not.toContain(keys.relay.privateKey);
            expect(text).not.toContain(keys.home.privateKey);
        }
    });

    it("refuses a value that would break a file", () => {
        expect(() => renderHomeConfig(keys, "198.51.100.20\nPostUp = x")).toThrow();
        expect(() =>
            renderRelayConfig({ relay: { privateKey: "nope", publicKey: "nope" }, home: keys.home })
        ).toThrow();
        expect(() => renderSideRelayConfig(keys, { tcp: [], udp: [RELAY_LISTEN_PORT] })).toThrow();
        expect(() => renderSideHomeConfig(keys, { tcp: [], udp: [1.5] })).toThrow();
        expect(() => renderSideHomeConfig(keys, withUdp, "192.0.2.10\nPostUp = x")).toThrow();
        expect(() => relayConfigs(keys, "198.51.100.20", { tcp: [0], udp: [] })).toThrow();
    });
    it("joins the edge's network on the relay end", () => {
        const configs = relayConfigs(keys, "198.51.100.20", webOnly);
        const relay = relaySpec("relay", configs.relay, webOnly, ["polaris-proxy"]);
        expect(relay.networks).toEqual(["polaris-proxy"]);
        // `default` is how the link reaches the side relay.
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
        expect(configs.relay.side).toBeNull();
        expect(configs.home.side).toBeNull();
        const relay = relaySpec("relay", configs.relay, webOnly);
        const ports = relay.services[0].ports.map((p) => `${p.host}/${p.protocol ?? "tcp"}`);
        // 80 and 443 belong to the server's edge, so the server can serve its own apps.
        expect(ports).toEqual([`${RELAY_LISTEN_PORT}/udp`]);
        expect(relay.services).toHaveLength(2);
        const home = relaySpec("home", configs.home, webOnly);
        expect(home.services[0].ports).toEqual([]);
        expect(home.services[0].extraHosts).toContain("host.docker.internal:host-gateway");
        // The files carry the address the entry above gives, whatever the resolver reads.
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

    it("runs the side link in containers of its own, publishing the side ports on the relay end", () => {
        const configs = relayConfigs(keys, "198.51.100.20", withUdp);
        const relay = relaySpec("relay", configs.relay, withUdp, ["polaris-proxy"]);
        const [helper, daemon, sideHelper, sideDaemon] = relay.services;
        expect(relay.services).toHaveLength(4);
        // The link publishes only its own port, whatever is installed.
        expect(helper.ports.map((p) => `${p.host}/${p.protocol ?? "tcp"}`)).toEqual([
            `${RELAY_LISTEN_PORT}/udp`
        ]);
        expect(helper.name).toBe(relayHelper());
        expect(sideHelper.name).toBe(relaySide());
        expect(sideHelper.name).not.toBe(helper.name);
        expect(daemon.image).toBe(WIREGUARD_IMAGE);
        expect(sideDaemon.image).toBe(WIREGUARD_IMAGE);
        expect(sideHelper.networks).toEqual(["default"]);
        expect(sideHelper.dependsOn).toEqual([helper.name]);
        expect(sideHelper.ports.map((p) => `${p.host}/${p.protocol ?? "tcp"}`)).toEqual([
            "25565/tcp",
            "19132/udp",
            "25565/udp"
        ]);
        expect(sideDaemon.networkMode).toBe(`service:${sideHelper.name}`);
        expect(decoded(sideHelper)).toBe(configs.relay.side);
        expect(decoded(helper)).toBe(configs.relay.wireguard);
        // A side port may be the status port's number, so the side relay serves none.
        expect(sideDaemon.command).not.toContain("--info");
        expect(daemon.command).toContain("--info");
        // Each end's files live in a volume of its own.
        expect(relay.volumes).toEqual([`${helper.name}-conf`, `${sideHelper.name}-conf`]);
        // Only the edge's network is declared; `default` is the project's own.
        expect(relay.networks).toEqual(["polaris-proxy"]);

        const home = relaySpec("home", configs.home, withUdp);
        const [homeHelper, , homeSideHelper, homeSideDaemon] = home.services;
        expect(home.services).toHaveLength(4);
        expect(homeSideHelper.ports).toEqual([]);
        expect(homeSideHelper.networks).toEqual(["default"]);
        expect(homeSideHelper.extraHosts).toEqual(["host.docker.internal:host-gateway"]);
        expect(homeSideHelper.command?.[2]).toContain("grep -F host.docker.internal /etc/hosts");
        expect(homeSideDaemon.command).toContain("--info");
        expect(homeHelper.ports).toEqual([]);
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

    it("raises the spec so the Update button brings both ends up with the call link", () => {
        expect(RELAY_SPEC).toBe(7);
    });

    it("carries the call ports on a link of their own, nested like the side link", () => {
        const carried = { tcp: [80, 443, 7881, 25565], udp: [7882, 19132] };
        const call = slotAddresses(RELAY_CALL_SLOT);
        // The web link's second constant forward.
        expect(renderRelayConfig(keys)).toContain(
            `[UDPServerTunnel]\nListenPort = ${CALL_WIRE_PORT}\nTarget = ${relayCall()}:${CALL_WIRE_PORT}`
        );
        expect(renderHomeConfig(keys, "198.51.100.20")).toContain(
            `[UDPProxyTunnel]\nBindAddress = 0.0.0.0:${CALL_WIRE_PORT}\nTarget = ${publicAddress}:${CALL_WIRE_PORT}`
        );
        expect(CALL_WIRE_PORT).not.toBe(SIDE_WIRE_PORT);
        const relayText = renderCallRelayConfig(keys, carried);
        expect(relayText).toContain(`ListenPort = ${CALL_WIRE_PORT}`);
        expect(relayText).toContain(`Address = ${call.publicAddress}/32`);
        expect(forwards(relayText)).toEqual(["[TCPClientTunnel] 7881", "[UDPProxyTunnel] 7882"]);
        const homeText = renderCallHomeConfig(keys, carried, "192.0.2.10");
        expect(homeText).toContain(`Endpoint = ${endNames("000000backup", "nat").helper}:${CALL_WIRE_PORT}`);
        expect(homeText).toContain("Target = 192.0.2.10:7882");
        // The side link no longer carries them.
        const sideText = renderSideRelayConfig(keys, carried);
        expect(forwards(sideText)).toEqual([
            "[TCPClientTunnel] 25565",
            "[UDPProxyTunnel] 19132"
        ]);
        // Published by the call helper on the relay end, after the side helper that
        // published them before.
        const configs = relayConfigs(keys, "198.51.100.20", carried, "192.0.2.10");
        const relay = relaySpec("relay", configs.relay, carried, ["polaris-proxy"]);
        expect(relay.services).toHaveLength(6);
        const callHelper = relay.services.find((service) => service.name === relayCall());
        expect(callHelper?.ports.map((p) => `${p.host}/${p.protocol ?? "tcp"}`)).toEqual([
            "7881/tcp",
            "7882/udp"
        ]);
        expect(callHelper?.dependsOn).toEqual([relayHelper(), relaySide()]);
        const sideHelper = relay.services.find((service) => service.name === relaySide());
        expect(sideHelper?.ports.map((p) => `${p.host}/${p.protocol ?? "tcp"}`)).toEqual([
            "25565/tcp",
            "19132/udp"
        ]);
        // A game port can never be the call link's wire port.
        expect(relayPorts([{ port: CALL_WIRE_PORT, protocol: "udp" }]).udp).toEqual([]);
    });

    it("adding or removing a game server leaves the link's containers exactly as they were", () => {
        // Compose recreates only what changed, so a link that renders the same is never
        // restarted - and the web, which rides it, never drops.
        const sets = [
            webOnly,
            withUdp,
            { tcp: [80, 443, 25565, 25566], udp: [19132, 25565, 50000] },
            { tcp: [80, 443, 25567], udp: [7882] }
        ];
        for (const end of ["relay", "home"] as const) {
            const links = sets.map((set) => {
                const configs = relayConfigs(keys, "198.51.100.20", set, "192.0.2.10");
                const spec = relaySpec(end, configs[end], set, ["polaris-proxy"]);
                return JSON.stringify(spec.services.slice(0, 2));
            });
            expect(new Set(links).size).toBe(1);
            // The web link's file itself, byte for byte, whatever games are installed.
            const files = sets.map((set) =>
                decoded(
                    relaySpec(
                        end,
                        relayConfigs(keys, "198.51.100.20", set, "192.0.2.10")[end],
                        set
                    ).services[0]
                )
            );
            expect(new Set(files).size).toBe(1);
            // Only the side link follows the games.
            const sides = sets.map(
                (set) => relayConfigs(keys, "198.51.100.20", set, "192.0.2.10")[end].side
            );
            expect(new Set(sides).size).toBe(sets.length);
        }
    });

    it("adding or removing a game server leaves the call link exactly as it was", () => {
        // The call link is what a call through the relay rides: recreated, every call
        // through it cuts until it shakes hands again.
        const games = [[], [25565], [25565, 25566], [25569]];
        for (const end of ["relay", "home"] as const) {
            const calls = games.map((ports) => {
                const set = { tcp: [80, 443, 7881, ...ports], udp: [7882, ...ports] };
                const configs = relayConfigs(keys, "198.51.100.20", set, "192.0.2.10");
                const spec = relaySpec(end, configs[end], set, ["polaris-proxy"]);
                const call = spec.services.filter((service) => service.name.includes("0000ca11ed00"));
                expect(call).toHaveLength(2);
                // Its file and its containers, apart from what it waits on to start,
                // which compose leaves out of the hash that decides a recreate.
                return JSON.stringify([configs[end].call, call.map(({ dependsOn: _, ...rest }) => rest)]);
            });
            expect(new Set(calls).size).toBe(1);
        }
    });
});
