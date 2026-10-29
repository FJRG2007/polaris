import { describe, expect, it } from "vitest";
import { NO_ROUTES_FILE } from "@polaris/core";
import { passthroughWaf, renderVpnEdge } from "@/lib/vpn/edge";
import { encodeHeadscaleConfig, renderHeadscaleConfig } from "@/lib/vpn/render";

const input = {
    hostname: "vpn.example.test",
    baseDomain: "vpn.internal",
    nameservers: ["192.168.1.10", "1.1.1.1"]
};

describe("renderHeadscaleConfig", () => {
    it("points clients at the VPN hostname over HTTPS and listens on every interface", () => {
        const config = renderHeadscaleConfig(input);
        expect(config).toContain('server_url: "https://vpn.example.test"');
        expect(config).toContain('listen_addr: "0.0.0.0:8080"');
    });

    it("keeps its state in sqlite on the volume and its policy in the database", () => {
        const config = renderHeadscaleConfig(input);
        expect(config).toContain("    path: /var/lib/headscale/db.sqlite");
        expect(config).toMatch(/policy:\n {2}mode: database/);
    });

    it("uses Tailscale's public relays and runs none of its own", () => {
        const config = renderHeadscaleConfig(input);
        expect(config).toContain("https://controlplane.tailscale.com/derpmap/default");
        expect(config).toMatch(/server:\n {4}enabled: false/);
    });

    it("lists the nameservers in order under MagicDNS", () => {
        const config = renderHeadscaleConfig(input);
        expect(config).toContain('base_domain: "vpn.internal"');
        expect(config).toMatch(/global:\n {6}- "192\.168\.1\.10"\n {6}- "1\.1\.1\.1"/);
    });

    it("falls back to public resolvers when given none", () => {
        expect(renderHeadscaleConfig({ ...input, nameservers: [] })).toContain('- "1.1.1.1"');
    });

    it("travels as base64 with no control character", () => {
        const encoded = encodeHeadscaleConfig(input);
        expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(renderHeadscaleConfig(input));
    });
});

describe("renderVpnEdge", () => {
    it("sends browser registration on the VPN host to the dashboard page", () => {
        const file = renderVpnEdge({
            hostname: "vpn.example.test",
            dashboardUrl: "https://polaris.example.test/"
        });
        expect(file).toContain('rule: "Host(`vpn.example.test`) && PathPrefix(`/register/`)"');
        expect(file).toContain("priority: 60");
        expect(file).toContain(
            'replacement: "https://polaris.example.test/apps/vpn/register/${1}"'
        );
        expect(file).toContain("hskey-authreq-[A-Za-z0-9_-]{24}");
    });

    it("routes nothing without a hostname, or with one that is not a hostname", () => {
        const dashboardUrl = "https://p.example.test";
        expect(renderVpnEdge({ hostname: null, dashboardUrl })).toBe(NO_ROUTES_FILE);
        expect(renderVpnEdge({ hostname: "vpn`.x", dashboardUrl })).toBe(NO_ROUTES_FILE);
        expect(
            renderVpnEdge({ hostname: "vpn.example.test", dashboardUrl: "javascript:alert(1)" })
        ).toBe(NO_ROUTES_FILE);
    });

    it("puts no guard in front of the control protocol", () => {
        expect(passthroughWaf).toMatchObject({
            sqlInjectionProtection: false,
            xssProtection: false,
            browserIntegrity: false,
            requireLogin: false,
            emailObfuscation: false,
            frameProtection: false
        });
    });
});
