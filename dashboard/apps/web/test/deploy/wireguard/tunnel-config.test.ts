import { describe, expect, it } from "vitest";
import * as wg from "@/lib/deploy/wireguard/tunnel-config";

const ID = "01923f4e-aaaa-7bbb-8ccc-0123456789ab";

describe("keys", () => {
    it("makes a WireGuard key pair whose public half belongs to its private half", () => {
        const pair = wg.generateKeyPair();
        expect(wg.isWireguardKey(pair.privateKey)).toBe(true);
        expect(wg.isWireguardKey(pair.publicKey)).toBe(true);
        expect(pair.privateKey).not.toBe(pair.publicKey);
        expect(Buffer.from(pair.publicKey, "base64")).toHaveLength(32);
        expect(wg.generateKeyPair().privateKey).not.toBe(pair.privateKey);
    });

    it("refuses a value that is not a key", () => {
        expect(wg.isWireguardKey("hello")).toBe(false);
        expect(wg.isWireguardKey(`${wg.generateKeyPair().publicKey}\n`)).toBe(false);
    });
});

describe("addresses", () => {
    it("gives each slot two addresses no other slot uses", () => {
        const seen = new Set<string>();
        for (let slot = 0; slot < 600; slot += 1) {
            const { publicAddress, peerAddress } = wg.slotAddresses(slot);
            expect(seen.has(publicAddress) || seen.has(peerAddress)).toBe(false);
            seen.add(publicAddress);
            seen.add(peerAddress);
        }
        expect(wg.slotAddresses(0)).toEqual({
            publicAddress: "10.213.0.1",
            peerAddress: "10.213.0.2"
        });
        expect(wg.slotAddresses(64)).toEqual({
            publicAddress: "10.213.1.1",
            peerAddress: "10.213.1.2"
        });
        expect(() => wg.slotAddresses(16384)).toThrow();
    });

    it("hands out the lowest free slot and port", () => {
        expect(wg.allocateSlot([])).toBe(0);
        expect(wg.allocateSlot([0, 1, 3])).toBe(2);
        expect(wg.allocateListenPort([wg.FIRST_LISTEN_PORT])).toBe(wg.FIRST_LISTEN_PORT + 1);
        const all = Array.from({ length: 180 }, (_, i) => wg.FIRST_LISTEN_PORT + i);
        expect(wg.allocateListenPort(all)).toBeNull();
    });
});

describe("config files", () => {
    const pub = wg.generateKeyPair();
    const nat = wg.generateKeyPair();

    it("lets the public end accept only the NAT end, on its tunnel address", () => {
        const text = wg.renderPublicConfig({
            privateKey: pub.privateKey,
            peerPublicKey: nat.publicKey,
            slot: 3,
            listenPort: 51821
        });
        expect(text).toContain(`PrivateKey = ${pub.privateKey}`);
        expect(text).toContain("ListenPort = 51821");
        expect(text).toContain(`PublicKey = ${nat.publicKey}`);
        expect(text).toContain("AllowedIPs = 10.213.0.14/32");
        expect(text).toContain("Target = 10.213.0.14:8080");
        expect(text).not.toContain("PersistentKeepalive");
        expect(text).not.toContain(nat.privateKey);
    });

    it("has the NAT end dial out with a keepalive and forward to the service", () => {
        const text = wg.renderNatConfig({
            privateKey: nat.privateKey,
            peerPublicKey: pub.publicKey,
            slot: 3,
            endpoint: "203.0.113.7:51821",
            origin: "web-app:3000"
        });
        expect(text).toContain("Endpoint = 203.0.113.7:51821");
        expect(text).toContain(`PersistentKeepalive = ${wg.KEEPALIVE_SECONDS}`);
        expect(text).toContain("AllowedIPs = 10.213.0.13/32");
        expect(text).toContain("Target = web-app:3000");
        expect(text).not.toContain("ListenPort = 5");
        expect(text).not.toContain(pub.privateKey);
    });

    it("refuses an endpoint or origin that could add a line", () => {
        const base = {
            privateKey: nat.privateKey,
            peerPublicKey: pub.publicKey,
            slot: 0,
            origin: "a:1"
        };
        expect(() => wg.renderNatConfig({ ...base, endpoint: "1.2.3.4:5\n[Peer]" })).toThrow();
        expect(() =>
            wg.renderNatConfig({ ...base, endpoint: "1.2.3.4:5", origin: "a:1\nx" })
        ).toThrow();
    });
});

describe("containers", () => {
    it("publishes the UDP port on the helper and keeps every value on one line", () => {
        const spec = wg.endSpec({
            tunnelId: ID,
            end: "public",
            config: "[Interface]\nA = 1\n",
            networks: ["polaris-proxy"],
            listenPort: 51820
        });
        const [helper, wireguard] = spec.services;
        expect(helper.ports).toEqual([{ host: 51820, container: 51820, protocol: "udp" }]);
        expect(wireguard.networkMode).toBe(`service:${helper.name}`);
        expect(wireguard.networks).toEqual([]);
        expect(wireguard.image).toMatch(/:[0-9a-f]{40}$/);
        for (const service of spec.services) {
            for (const value of [...Object.values(service.env), ...(service.command ?? [])]) {
                expect(value).not.toMatch(/[\u0000-\u001f]/);
            }
        }
        expect(Buffer.from(helper.env.WG_CONFIG, "base64").toString("utf8")).toBe(
            "[Interface]\nA = 1\n"
        );
        // The config file holds a private key, so it goes when the container stops.
        expect(helper.command?.join(" ")).toContain(
            "trap 'rm -f /etc/wireproxy/config; exit 0' TERM INT"
        );
        expect(helper.image).toBe(wg.HELPER_IMAGE);
        expect(helper.pullPolicy).toBe("missing");
        expect(wireguard.pullPolicy).toBe("missing");
    });

    it("opens no port on the end behind NAT", () => {
        const spec = wg.endSpec({
            tunnelId: ID,
            end: "nat",
            config: "x",
            networks: ["polaris-proxy"]
        });
        expect(spec.services.every((service) => service.ports.length === 0)).toBe(true);
        expect(spec.project).not.toBe(
            wg.endSpec({ tunnelId: ID, end: "public", config: "x", networks: [] }).project
        );
    });
});

describe("edge routes", () => {
    it("gives every router an explicit priority and dials the public end", () => {
        const yaml = wg.renderTunnelRoutes([{ id: ID, hostname: "app.example.com" }]);
        const routers = yaml.match(/^ {4}polaris-wg-[a-z0-9-]+:$/gm) ?? [];
        // Two routers, their service and the redirect middleware.
        expect(routers.length).toBe(4);
        expect(yaml.match(new RegExp(`priority: ${wg.TUNNEL_ROUTE_PRIORITY}`, "g"))).toHaveLength(
            2
        );
        expect(yaml).toContain("Host(`app.example.com`)");
        expect(yaml).toContain('url: "http://wg-pub-0123456789ab:8080"');
        expect(yaml).toContain("certResolver: letsencrypt");
    });

    it("is never empty and drops a hostname that could break the rule", () => {
        expect(wg.renderTunnelRoutes([]).trim().length).toBeGreaterThan(0);
        expect(
            wg.renderTunnelRoutes([{ id: ID, hostname: "x`) || Host(`evil.com" }])
        ).not.toContain("routers");
    });
});

describe("live state", () => {
    const peer = wg.generateKeyPair().publicKey;

    it("reads the handshake and bytes of each peer", () => {
        const text = [
            "private_key=abcd",
            "listen_port=51820",
            `public_key=${wg.keyToHex(peer)}`,
            "endpoint=198.51.100.4:40211",
            "last_handshake_time_sec=1760000000",
            "last_handshake_time_nsec=12",
            "rx_bytes=1048576",
            "tx_bytes=2048",
            "persistent_keepalive_interval=25",
            "allowed_ip=10.213.0.2/32",
            "errno=0",
            ""
        ].join("\n");
        expect(wg.parseDeviceState(text)).toEqual([
            {
                publicKeyHex: wg.keyToHex(peer),
                endpoint: "198.51.100.4:40211",
                lastHandshake: 1760000000,
                rxBytes: 1048576,
                txBytes: 2048
            }
        ]);
    });

    it("reads a peer that never shook hands, and nothing from junk", () => {
        const [only] = wg.parseDeviceState(`public_key=${wg.keyToHex(peer)}\nrx_bytes=0\n`);
        expect(only.lastHandshake).toBe(0);
        expect(only.endpoint).toBeNull();
        expect(wg.parseDeviceState("<html>502</html>")).toEqual([]);
    });

    it("calls a tunnel up, waiting or down from its handshake age", () => {
        expect(wg.tunnelHealth(0, 1000)).toBe("waiting");
        expect(wg.tunnelHealth(900, 1000)).toBe("up");
        expect(wg.tunnelHealth(100, 1000)).toBe("down");
    });
});
