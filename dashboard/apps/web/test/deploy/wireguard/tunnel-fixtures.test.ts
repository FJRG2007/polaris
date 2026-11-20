import { describe, expect, it } from "vitest";
import * as relay from "@/lib/backup-access/relay";
import * as wg from "@/lib/deploy/wireguard/tunnel-config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * The files the dashboard renders for the tunnel daemon, kept beside the daemon's
 * crate: `crates/polaris-tunnel/tests/fixtures.rs` parses every one of them, so a
 * renderer that writes something the daemon refuses fails a test on one side or
 * the other. The keys are fixed fixture keys, never used anywhere else.
 *
 * `UPDATE_TUNNEL_FIXTURES=1` rewrites the files; otherwise they must match.
 */
const FIXTURES = new URL("../../../../../../crates/polaris-tunnel/tests/fixtures/", import.meta.url);

/** Fixture keys: clamped SHA-256 of "fixture-relay" and "fixture-home". */
const RELAY_KEY: wg.KeyPair = {
    privateKey: "kIDSrJR+cWbbDO2tKZu4UOWS/KZsLgeZg9ebuETP+Ho=",
    publicKey: "H1rVTCq9R6uneqH/iHv0NA/BmI22UIbLYWfxWXEBw38="
};
const HOME_KEY: wg.KeyPair = {
    privateKey: "KOJ59O3wWAzgVPKSuL2SxWz7xznDVyTxu+eVQt0SfHg=",
    publicKey: "1MQX58+13U+z3jOrS+Pi1jy73Uo/164DFt+EJ+mBAWw="
};

/** The call ports and one game on both protocols. */
const CARRIED = relay.relayPorts([
    { port: 7881, protocol: "tcp" },
    { port: 7882, protocol: "udp" },
    { port: 25565, protocol: "tcp" },
    { port: 19132, protocol: "udp" }
]);

function rendered(): Record<string, string> {
    const keys = { relay: RELAY_KEY, home: HOME_KEY };
    const configs = relay.relayConfigs(keys, "198.51.100.20", CARRIED, "192.0.2.10");
    return {
        "deploy-public.conf": wg.renderPublicConfig({
            privateKey: RELAY_KEY.privateKey,
            peerPublicKey: HOME_KEY.publicKey,
            slot: 3,
            listenPort: 51821
        }),
        "deploy-nat.conf": wg.renderNatConfig({
            privateKey: HOME_KEY.privateKey,
            peerPublicKey: RELAY_KEY.publicKey,
            slot: 3,
            endpoint: "203.0.113.7:51821",
            origin: "web-app:3000"
        }),
        "relay-web-relay.conf": configs.relay.wireguard,
        "relay-web-home.conf": configs.home.wireguard,
        "relay-side-relay.conf": configs.relay.side ?? "",
        "relay-side-home.conf": configs.home.side ?? "",
        "relay-call-relay.conf": configs.relay.call ?? "",
        "relay-call-home.conf": configs.home.call ?? ""
    };
}

describe("tunnel daemon fixtures", () => {
    it("are exactly what the renderers write today", () => {
        const update = process.env.UPDATE_TUNNEL_FIXTURES === "1";
        for (const [name, text] of Object.entries(rendered())) {
            expect(text, name).not.toBe("");
            const file = new URL(name, FIXTURES);
            if (update) writeFileSync(file, text);
            expect(existsSync(file), `${name} is missing; run with UPDATE_TUNNEL_FIXTURES=1`).toBe(
                true
            );
            expect(readFileSync(file, "utf8").replaceAll("\r\n", "\n"), name).toBe(text);
        }
    });

    it("read the daemon's own /metrics output as the screen does", () => {
        // Written by the daemon's `render_metrics` and pinned by fixtures.rs.
        const text = readFileSync(new URL("metrics.txt", FIXTURES), "utf8");
        expect(wg.parseDeviceState(text)).toEqual([
            {
                publicKeyHex: wg.keyToHex(RELAY_KEY.publicKey),
                endpoint: "198.51.100.20:52000",
                lastHandshake: 1_763_100_000,
                rxBytes: 1_048_576,
                txBytes: 2048
            }
        ]);
        // A daemon that never shook hands: no endpoint yet, a zero handshake.
        const fresh = readFileSync(new URL("metrics-fresh.txt", FIXTURES), "utf8");
        expect(wg.parseDeviceState(fresh)).toEqual([
            {
                publicKeyHex: "00".repeat(32),
                endpoint: null,
                lastHandshake: 0,
                rxBytes: 0,
                txBytes: 0
            }
        ]);
        expect(wg.tunnelHealth(0, 1_763_100_000)).toBe("waiting");
    });
});
