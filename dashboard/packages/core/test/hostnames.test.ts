import { describe, expect, it } from "vitest";
import { isTunnelHostname } from "../src/hostnames.js";

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
        expect(isTunnelHostname("orphion-ef161a-192-168-1-138.sslip.io")).toBe(false);
        expect(isTunnelHostname("app.example.com")).toBe(false);
        expect(isTunnelHostname("myapp.duckdns.org")).toBe(false);
        expect(isTunnelHostname("service.plr.local")).toBe(false);
    });

    it("does not flag a lookalike that only contains the word", () => {
        expect(isTunnelHostname("trycloudflare.com.evil.example")).toBe(false);
        expect(isTunnelHostname("notngrok.io")).toBe(false);
    });
});
