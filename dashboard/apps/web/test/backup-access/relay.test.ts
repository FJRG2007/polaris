import { describe, expect, it } from "vitest";
import { generateKeyPair, slotAddresses } from "../../src/lib/deploy/wireguard/tunnel-config";
import {
    RELAY_LISTEN_PORT,
    RELAY_SLOT,
    relayPorts,
    relayProject,
    relaySpec,
    renderHomeConfig,
    renderRelayConfig
} from "../../src/lib/backup-access/relay";

const keys = { relay: generateKeyPair(), home: generateKeyPair() };
const { publicAddress, peerAddress } = slotAddresses(RELAY_SLOT);

describe("backup relay config", () => {
    it("carries the web ports and TCP game ports, and names the UDP ones it cannot", () => {
        const ports = relayPorts([
            { port: 25565, protocol: "tcp" },
            { port: 19132, protocol: "udp" },
            { port: 443, protocol: "tcp" },
            { port: 0, protocol: "tcp" },
            { port: RELAY_LISTEN_PORT, protocol: "tcp" }
        ]);
        expect(ports).toEqual({ tcp: [80, 443, 25565], skippedUdp: [19132] });
    });

    it("renders the relay end: listens for the house only, forwards each port", () => {
        const text = renderRelayConfig(keys, [80, 443]);
        expect(text).toContain(`ListenPort = ${RELAY_LISTEN_PORT}`);
        expect(text).toContain(`PublicKey = ${keys.home.publicKey}`);
        expect(text).toContain(`AllowedIPs = ${peerAddress}/32`);
        expect(text).toContain(`BindAddress = 0.0.0.0:443\nTarget = ${peerAddress}:443`);
        expect(text.match(/\[TCPClientTunnel\]/g)).toHaveLength(2);
        expect(text).not.toContain(keys.home.privateKey);
    });

    it("renders the house end: dials out with a keepalive, hands ports to this machine", () => {
        const text = renderHomeConfig(keys, "198.51.100.20", [80, 443, 25565]);
        expect(text).toContain(`Endpoint = 198.51.100.20:${RELAY_LISTEN_PORT}`);
        expect(text).toContain("PersistentKeepalive = 25");
        expect(text).toContain(`AllowedIPs = ${publicAddress}/32`);
        expect(text).toContain("ListenPort = 25565\nTarget = host.docker.internal:25565");
        expect(text).not.toContain(keys.relay.privateKey);
        expect(renderHomeConfig(keys, "2001:db8::1", [80])).toContain(
            `Endpoint = [2001:db8::1]:${RELAY_LISTEN_PORT}`
        );
    });

    it("refuses a value that would break the file", () => {
        expect(() => renderHomeConfig(keys, "198.51.100.20\nPostUp = x", [80])).toThrow();
        expect(() =>
            renderRelayConfig({ relay: { privateKey: "nope", publicKey: "nope" }, home: keys.home }, [80])
        ).toThrow();
    });

    it("publishes the carried ports on the relay end only", () => {
        const relay = relaySpec("relay", "cfg", [80, 443]);
        const ports = relay.services[0].ports.map((p) => `${p.host}/${p.protocol ?? "tcp"}`);
        expect(ports).toEqual([`${RELAY_LISTEN_PORT}/udp`, "80/tcp", "443/tcp"]);
        const home = relaySpec("home", "cfg", [80, 443]);
        expect(home.services[0].ports).toEqual([]);
        expect(home.services[0].extraHosts).toContain("host.docker.internal:host-gateway");
        expect(relay.project).toBe(relayProject("relay"));
        expect(home.project).toBe(relayProject("home"));
        expect(relay.project).not.toBe(home.project);
    });
});
