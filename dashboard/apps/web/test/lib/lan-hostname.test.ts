import { describe, expect, it } from "vitest";
import { lanHostname, renderLanRoute } from "@/lib/lan-hostname";

describe("lanHostname", () => {
    it("names a private IPv4 one label under the base", () => {
        expect(lanHostname("192.168.1.142", "Example.com")).toBe("lan-192-168-1-142.example.com");
        expect(lanHostname("10.0.0.5", "plr.example.org")).toBe("lan-10-0-0-5.plr.example.org");
        expect(lanHostname("172.20.3.4", "example.com")).toBe("lan-172-20-3-4.example.com");
    });

    it("refuses anything that is not a private IPv4", () => {
        for (const ip of ["8.8.8.8", "172.32.0.1", "192.169.0.1", "256.1.1.1", "fe80::1", ""]) {
            expect(lanHostname(ip, "example.com"), ip).toBeNull();
        }
        expect(lanHostname("192.168.1.2", "")).toBeNull();
    });
});

describe("renderLanRoute", () => {
    it("is empty without a name", () => {
        expect(renderLanRoute(null, "http://web:3000")).toBe("# No routes.\n");
    });

    it("serves the name from the certificate store, LAN callers only, at an explicit priority", () => {
        const file = renderLanRoute("lan-192-168-1-2.example.com", "http://web:3000");
        expect(file).toContain('rule: "Host(`lan-192-168-1-2.example.com`)"');
        expect(file).toContain("priority: 50");
        expect(file).toContain("tls: {}");
        expect(file).not.toContain("certResolver");
        expect(file).toContain('"192.168.0.0/16"');
        expect(file).not.toContain('"0.0.0.0/0"');
        expect(file).toContain('- url: "http://web:3000"');
        expect(file.endsWith("\n")).toBe(true);
    });
});
