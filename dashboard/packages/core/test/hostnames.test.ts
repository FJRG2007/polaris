import { describe, expect, it } from "vitest";
import {
    isDnsLabel,
    isDomainName,
    isTunnelHostname,
    normalizeHostInput,
    normalizeSiteAddress
} from "../src/hostnames.js";

describe("isTunnelHostname", () => {
    it("flags Cloudflare quick-tunnel hosts", () => {
        expect(isTunnelHostname("ronald-kent-leg-plate.trycloudflare.com")).toBe(true);
    });

    it("flags ngrok hosts", () => {
        expect(isTunnelHostname("abc123.ngrok-free.app")).toBe(true);
        expect(isTunnelHostname("abc123.ngrok.io")).toBe(true);
        expect(isTunnelHostname("abc123.ngrok.app")).toBe(true);
    });

    it("flags the internal quick-tunnel edge host", () => {
        expect(isTunnelHostname("a1b2c3d4.qtunnel.polaris")).toBe(true);
    });

    it("tolerates a scheme, path, or port a user might paste", () => {
        expect(isTunnelHostname("https://ronald-kent-leg-plate.trycloudflare.com/")).toBe(true);
        expect(isTunnelHostname("  HTTPS://Foo.TryCloudflare.com:443/path  ")).toBe(true);
    });

    it("does not flag real domains or sslip.io names", () => {
        expect(isTunnelHostname("storefront-ef161a-10-0-1-138.sslip.io")).toBe(false);
        expect(isTunnelHostname("app.example.com")).toBe(false);
        expect(isTunnelHostname("myapp.duckdns.org")).toBe(false);
        expect(isTunnelHostname("service.plr.local")).toBe(false);
    });

    it("does not flag a lookalike that only contains the word", () => {
        expect(isTunnelHostname("trycloudflare.com.evil.example")).toBe(false);
        expect(isTunnelHostname("notngrok.io")).toBe(false);
    });
});

describe("typed domain fields", () => {
    it("reads a pasted host the way a comparison needs it", () => {
        expect(normalizeHostInput(" HTTPS://Apps.Example.com:8443/path?q ")).toBe("apps.example.com");
        expect(normalizeHostInput("example.com.")).toBe("example.com");
        expect(normalizeHostInput("////")).toBe("");
    });

    it("tells a domain name and a label from anything else", () => {
        expect(isDomainName("example.com")).toBe(true);
        expect(isDomainName("example")).toBe(false);
        expect(isDomainName("a..com")).toBe(false);
        expect(isDomainName("-a.com")).toBe(false);
        expect(isDnsLabel("plr")).toBe(true);
        expect(isDnsLabel("p.lr")).toBe(false);
    });

    it("keeps a site address in one stored form, or refuses it", () => {
        expect(normalizeSiteAddress("https://Polaris.Example.com/")).toBe("polaris.example.com");
        expect(normalizeSiteAddress("http://10.0.0.5:3000/")).toBe("http://10.0.0.5:3000");
        expect(normalizeSiteAddress("////")).toBeNull();
        expect(normalizeSiteAddress("example.com/share")).toBeNull();
        expect(normalizeSiteAddress("ftp://example.com")).toBeNull();
        expect(normalizeSiteAddress("999.1.1.1")).toBeNull();
        expect(normalizeSiteAddress("example.com:0")).toBeNull();
    });
});
