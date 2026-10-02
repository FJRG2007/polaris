/**
 * The control plane at the end of somebody's home broadband goes away, and the services
 * it deployed onto other servers must not notice. Each case here is one decision that
 * used to depend on Polaris being reachable and now lives on the server that serves the
 * request - or, for DNS, one that must never put Polaris in front of it at all.
 */

import { describe, expect, it } from "vitest";
import { dnsAddressFor } from "@/lib/domain-dns";
import { readEdgeProbe } from "@/lib/deploy/server-edge";
import { classifyStale } from "@/lib/domain-address-sync";
import { intelFingerprint } from "@/lib/waf-intel-service";
import { remoteIntelScript } from "@/lib/deploy/router-remote";
import { needsHandedCertificate } from "@/lib/tls/managed-cert-plan";

const HOME = "198.51.100.7";
// A routable address, as a cloud server has: the documentation ranges are reserved,
// and a reserved address is exactly what the decision refuses to point DNS at.
const EC2 = "54.0.0.10";

describe("where a domain's record points", () => {
    it("names the server that serves it, never the control plane", () => {
        expect(dnsAddressFor({ remote: true, servedBy: "server", serverAddresses: [EC2] }, HOME)).toBe(EC2);
    });

    it("leaves the record to the operator when that server has no public address, rather than guess", () => {
        expect(dnsAddressFor({ remote: true, servedBy: "server", serverAddresses: ["10.0.1.5"] }, HOME)).toBeNull();
        expect(dnsAddressFor({ remote: true, servedBy: "server", serverAddresses: [] }, HOME)).toBeNull();
    });

    it("names the control plane only for what it serves itself", () => {
        expect(dnsAddressFor({ remote: false, servedBy: "server", serverAddresses: [] }, HOME)).toBe(HOME);
        expect(dnsAddressFor({ remote: true, servedBy: "polaris", serverAddresses: [EC2] }, HOME)).toBe(HOME);
    });

    it("is never repointed home by the address sync, before or after an outage", () => {
        // The zone sync only corrects records that named this machine's previous
        // address; a record naming another server is somebody's deliberate record.
        const { ours, theirs } = classifyStale([{ name: "example.com", addresses: [EC2] }], HOME, "198.51.100.1");
        expect(ours).toEqual([]);
        expect(theirs.map((entry) => entry.name)).toEqual(["example.com"]);
    });
});

describe("certificates on another server", () => {
    it("are handed over only for a wildcard; an exact name renews on that server", () => {
        expect(needsHandedCertificate({ hostname: "*.example.com" })).toBe(true);
        expect(needsHandedCertificate({ hostname: "example.com" })).toBe(false);
        expect(needsHandedCertificate({ hostname: "api.example.com" })).toBe(false);
    });
});

describe("the address list a server's guard keeps", () => {
    it("is written beside its target and renamed over it", () => {
        const script = remoteIntelScript("n0nce");

        expect(script).toContain("/var/lib/polaris/edge-intel/.waf-intel.json.n0nce");
        expect(script).toMatch(/mv -f \S+\.n0nce \S*\/var\/lib\/polaris\/edge-intel\/waf-intel\.json/);
        expect(script).toMatch(/cat > \S+\.n0nce/);
    });

    it("arrives on stdin, so its size is not bounded by the command line", () => {
        const script = remoteIntelScript("n0nce");

        expect(script).not.toContain("base64");
        expect(script.length).toBeLessThan(512);
    });

    it("is pushed again only when what it says changed, not when it was written", () => {
        const a = intelFingerprint({ v: 1, at: 1, ips: { "1.2.3.4": { reason: "ban", until: null } } });
        const b = intelFingerprint({ v: 1, at: 2, ips: { "1.2.3.4": { reason: "ban", until: null } } });
        const c = intelFingerprint({ v: 1, at: 2, ips: {} });

        expect(a).toBe(b);
        expect(a).not.toBe(c);
    });

    it("is reported missing on a server whose guard predates it", () => {
        expect(readEdgeProbe("traefik=true\nguard=true\npushable=true\noffline=false\n").offline).toBe(false);
        expect(readEdgeProbe("traefik=true\nguard=true\npushable=true\noffline=true\n").offline).toBe(true);
    });
});
