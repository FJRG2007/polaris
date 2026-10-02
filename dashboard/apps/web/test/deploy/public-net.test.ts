/**
 * The decisions behind a service's public networking panel: which ports a
 * container listens on, what a custom hostname's DNS says, how near a certificate
 * is to expiring, and which public port a TCP proxy takes.
 */

import { describe, expect, it } from "vitest";
import * as net from "@/lib/deploy/public-net";

/** `/proc/net/tcp` then `/proc/net/tcp6`, as `cat` prints them inside a container. */
const TABLE = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0 100 0 0 10 0",
    "   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2 1 0 100 0 0 10 0",
    "   2: 0200A8C0:0BB8 0101A8C0:D2F0 01 00000000:00000000 00:00000000 00000000  1000        0 3 1 0 100 0 0 10 0",
    "  sl  local_address                         remote_address                        st tx_queue rx_queue",
    "   0: 00000000000000000000000000000000:1F40 00000000000000000000000000000000:0000 0A 00000000:00000000",
    "   1: 00000000000000000000000001000000:2328 00000000000000000000000000000000:0000 0A 00000000:00000000",
    "   2: 0000000000000000FFFF00000100007F:2710 00000000000000000000000000000000:0000 0A 00000000:00000000",
    "   3: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000"
].join("\n");

describe("parseListeningPorts", () => {
    it("lists the ports another container can reach, once each", () => {
        expect(net.parseListeningPorts(TABLE)).toEqual([3000, 8000]);
    });

    it("leaves out loopback - 127.0.0.1, ::1 and the IPv4-mapped form - and open connections", () => {
        const ports = net.parseListeningPorts(TABLE);
        expect(ports).not.toContain(8080);
        expect(ports).not.toContain(9000);
        expect(ports).not.toContain(10000);
    });

    it("reads nothing out of a table it does not recognise", () => {
        expect(net.parseListeningPorts("cat: /proc/net/tcp6: No such file or directory")).toEqual([]);
        expect(net.parseListeningPorts("")).toEqual([]);
    });
});

describe("dnsVerdict", () => {
    const expected = { ip: "203.0.113.7", cnameTargets: ["web.plr.example.com"] };

    it("is ok for a CNAME to one of the service's own names, with or without the root dot", () => {
        expect(net.dnsVerdict({ addresses: ["203.0.113.7"], cnames: ["web.plr.example.com."] }, expected)).toBe("ok");
    });

    it("is ok for an address that is this server", () => {
        expect(net.dnsVerdict({ addresses: ["203.0.113.7"], cnames: [] }, expected)).toBe("ok");
    });

    it("recognises Cloudflare's edge on both families", () => {
        expect(net.dnsVerdict({ addresses: ["104.16.1.1"], cnames: [] }, expected)).toBe("proxied");
        expect(net.dnsVerdict({ addresses: ["2606:4700::6810:1"], cnames: [] }, expected)).toBe("proxied");
    });

    it("tells a name pointing elsewhere from one that does not resolve", () => {
        expect(net.dnsVerdict({ addresses: ["198.51.100.1"], cnames: [] }, expected)).toBe("elsewhere");
        expect(net.dnsVerdict({ addresses: [], cnames: [] }, expected)).toBe("missing");
    });

    it("never says ok without knowing where here is", () => {
        expect(net.dnsVerdict({ addresses: ["203.0.113.7"], cnames: [] }, { ip: null, cnameTargets: [] })).toBe(
            "elsewhere"
        );
    });
});

describe("certVerdict", () => {
    const now = Date.UTC(2026, 9, 2);
    const day = 86_400_000;

    it("reads a certificate with more than 30 days left as valid", () => {
        expect(net.certVerdict({ validTo: new Date(now + 60 * day), trusted: true }, now)).toBe("valid");
        expect(net.daysUntil(new Date(now + 60 * day), now)).toBe(60);
    });

    it("reads one inside the renewal window as renewing, and a lapsed one as expired", () => {
        expect(net.certVerdict({ validTo: new Date(now + 10 * day), trusted: true }, now)).toBe("renewing");
        expect(net.certVerdict({ validTo: new Date(now - day), trusted: true }, now)).toBe("expired");
        expect(net.daysUntil(new Date(now - day), now)).toBe(0);
    });

    it("reads the edge's own default certificate as untrusted, not valid", () => {
        expect(net.certVerdict({ validTo: new Date(now + 300 * day), trusted: false }, now)).toBe("untrusted");
    });
});

describe("TCP proxy ports", () => {
    it("picks a port in its own band, skipping the taken ones", () => {
        const first = net.pickProxyPort(new Set(), 0);
        expect(first).toBe(net.TCP_PROXY_PORT_MIN);
        expect(net.pickProxyPort(new Set([net.TCP_PROXY_PORT_MIN]), 0)).toBe(net.TCP_PROXY_PORT_MIN + 1);
        const seeded = net.pickProxyPort(new Set(), 123_456);
        expect(seeded).toBeGreaterThanOrEqual(net.TCP_PROXY_PORT_MIN);
        expect(seeded).toBeLessThanOrEqual(net.TCP_PROXY_PORT_MAX);
    });

    it("stays clear of the band services' own published ports come from", () => {
        expect(net.TCP_PROXY_PORT_MIN).toBeGreaterThan(39_999);
        expect(net.TCP_PROXY_PORT_MAX).toBeLessThan(49_152);
    });

    it("says so when the band is full", () => {
        const all = new Set<number>();
        for (let port = net.TCP_PROXY_PORT_MIN; port <= net.TCP_PROXY_PORT_MAX; port += 1) all.add(port);
        expect(net.pickProxyPort(all, 7)).toBeNull();
    });

    it("reads the stored proxies and every published port, ignoring junk", () => {
        const source = {
            hostPort: 25565,
            extraPorts: [{ host: 19132, container: 19132, protocol: "udp" }],
            tcpProxies: [{ container: 5432, host: 41000 }, { container: "x" }, null]
        };
        expect(net.tcpProxiesOf(source)).toEqual([{ container: 5432, host: 41000 }]);
        expect(net.publishedPortsOf(source).sort()).toEqual([19132, 25565, 41000]);
    });
});
