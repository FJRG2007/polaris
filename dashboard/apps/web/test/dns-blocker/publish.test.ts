import { describe, expect, it } from "vitest";
import { boundSource, dnsPublishSpec } from "@/lib/dns-blocker/publish";
import { appComposeSpec, forCompose, isPortTaken, renderComposeYaml } from "@polaris/deploy";

describe("dnsPublishSpec", () => {
    it("publishes 53 on UDP and TCP, bound to the LAN address only", () => {
        expect(dnsPublishSpec("192.168.1.20")).toEqual({
            primary: { host: 53, container: 53, protocol: "udp" },
            extra: [{ host: 53, container: 53, protocol: "tcp" }],
            hostIp: "192.168.1.20"
        });
    });
});

describe("boundSource", () => {
    it("binds an engine installed on every interface, keeping the rest of its source", () => {
        const stored = JSON.stringify({
            imageRef: "blocky:1",
            port: 53,
            hostPort: 53,
            hostProtocol: "udp"
        });
        expect(JSON.parse(boundSource(stored, "10.0.0.5")!)).toEqual({
            imageRef: "blocky:1",
            port: 53,
            hostPort: 53,
            hostProtocol: "udp",
            extraPorts: [{ host: 53, container: 53, protocol: "tcp" }],
            hostIp: "10.0.0.5"
        });
    });

    it("leaves an engine already bound to that address alone", () => {
        expect(boundSource(JSON.stringify({ hostIp: "10.0.0.5" }), "10.0.0.5")).toBeNull();
    });

    it("rebinds when the machine's address changed, and survives an unreadable source", () => {
        expect(
            JSON.parse(boundSource(JSON.stringify({ hostIp: "10.0.0.4" }), "10.0.0.5")!).hostIp
        ).toBe("10.0.0.5");
        expect(JSON.parse(boundSource("not json", "10.0.0.5")!).hostIp).toBe("10.0.0.5");
    });
});

describe("isPortTaken", () => {
    it("reads the daemon's words for a port it could not bind", () => {
        expect(
            isPortTaken(
                "Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint marketplace-ad-blocker-dns-server-1"
            )
        ).toBe(true);
        expect(isPortTaken("listen udp4 0.0.0.0:53: bind: address already in use")).toBe(true);
        expect(isPortTaken("manifest unknown")).toBe(false);
    });

    it("does not call an address the machine no longer has a taken port", () => {
        expect(
            isPortTaken(
                "driver failed programming external connectivity on endpoint dns: Error starting userland proxy: listen tcp4 192.168.1.20:53: bind: cannot assign requested address"
            )
        ).toBe(false);
    });
});

describe("compose rendering of a bound port", () => {
    it("prefixes the host address, and leaves an unbound port on every interface", () => {
        const plan = {
            ref: { name: "dns", project: "polaris-p" },
            build: {
                method: "image",
                name: "dns",
                source: { kind: "image", image: "spx01/blocky" }
            },
            env: {},
            volumes: [],
            domains: [],
            expose: { host: 53, container: 53, protocol: "udp" as const, hostIp: "192.168.1.20" },
            extraPorts: [
                { host: 53, container: 53, protocol: "tcp" as const, hostIp: "192.168.1.20" },
                { host: 8080, container: 80 }
            ]
        };
        const spec = appComposeSpec(plan as never, "spx01/blocky", "polaris");
        expect(spec.services[0]!.ports).toEqual([
            { host: 53, container: 53, protocol: "udp", hostIp: "192.168.1.20" },
            { host: 53, container: 53, protocol: "tcp", hostIp: "192.168.1.20" },
            { host: 8080, container: 80 }
        ]);
        const yaml = renderComposeYaml(forCompose(spec), "/v", "/m");
        expect(yaml).toContain('"192.168.1.20:53:53/udp"');
        expect(yaml).toContain('"192.168.1.20:53:53"');
        expect(yaml).toContain('"8080:80"');
    });
});
