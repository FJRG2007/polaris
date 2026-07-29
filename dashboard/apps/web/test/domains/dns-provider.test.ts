/**
 * Recognizing the DNS provider from a zone's nameservers. What is protected here is
 * the matching itself: a provider identified wrongly sends the operator to a panel
 * that does not hold their records, which is worse than not guessing at all - so the
 * real-world nameserver names are pinned, and an unknown one stays unknown.
 */

import { describe, expect, it } from "vitest";
import { dnsProviderFor } from "../../src/lib/dns-provider";

describe("dnsProviderFor", () => {
    it("recognizes the providers most domains are served by", () => {
        const cases: Array<[string[], string]> = [
            [["dana.ns.cloudflare.com", "rick.ns.cloudflare.com"], "cloudflare"],
            // Not every Cloudflare zone is delegated to the `*.ns.cloudflare.com` pool.
            [["ns3.cloudflare.com", "ns4.cloudflare.com"], "cloudflare"],
            [["red.foundationdns.com", "blue.foundationdns.com"], "cloudflare"],
            [["cns1.godaddy.com", "cns2.godaddy.com"], "godaddy"],
            [["ns1.your-server.de", "ns.second-ns.de"], "hetzner"],
            [["ns-1520.awsdns-62.org", "ns-47.awsdns-05.com"], "route53"],
            [["ns37.domaincontrol.com", "ns38.domaincontrol.com"], "godaddy"],
            [["dns1.registrar-servers.com", "dns2.registrar-servers.com"], "namecheap"],
            [["ns1.dns-parking.com", "ns2.dns-parking.com"], "hostinger"],
            [["ns1.vercel-dns.com", "ns2.vercel-dns.com"], "vercel"],
            [["dns1.p01.nsone.net", "dns2.p01.nsone.net"], "ns1"],
            [["ns1.digitalocean.com", "ns2.digitalocean.com"], "digitalocean"],
            [["ns-cloud-a1.googledomains.com", "ns-cloud-a2.googledomains.com"], "google"],
            [["ns1-01.azure-dns.com", "ns2-01.azure-dns.net"], "azure"],
            [["dns18.ovh.net", "ns18.ovh.net"], "ovh"],
            [["ns1074.ui-dns.com", "ns1105.ui-dns.de"], "ionos"],
            [["hydrogen.ns1.hetzner.com", "oxygen.ns1.hetzner.com"], "hetzner"],
            [["curitiba.ns.porkbun.com", "fortaleza.ns.porkbun.com"], "porkbun"],
            [["ns1.duckdns.org", "ns2.duckdns.org"], "duckdns"]
        ];
        for (const [nameservers, id] of cases) {
            expect(dnsProviderFor(nameservers)?.id, nameservers[0]).toBe(id);
        }
    });

    it("matches however the resolver returns the names, in case or with the root dot", () => {
        expect(dnsProviderFor(["DANA.NS.CLOUDFLARE.COM."])?.id).toBe("cloudflare");
        expect(dnsProviderFor([" ns37.domaincontrol.com. "])?.id).toBe("godaddy");
    });

    it("stays unknown rather than guessing at a provider it does not know", () => {
        expect(dnsProviderFor(["ns1.some-tiny-registrar.example", "ns2.some-tiny-registrar.example"])).toBeNull();
        expect(dnsProviderFor([])).toBeNull();
    });

    it("only claims to automate what Polaris can actually create records through", () => {
        expect(dnsProviderFor(["dana.ns.cloudflare.com"])?.automatable).toBe(true);
        expect(dnsProviderFor(["ns37.domaincontrol.com"])?.automatable).toBeUndefined();
    });

    it("links to the domain's own records where the provider has a per-domain URL", () => {
        const cloudflare = dnsProviderFor(["dana.ns.cloudflare.com"]);
        expect(cloudflare?.url?.("example.com")).toBe(
            "https://dash.cloudflare.com/?to=/:account/example.com/dns/records"
        );
        const namecheap = dnsProviderFor(["dns1.registrar-servers.com"]);
        expect(namecheap?.url?.("example.com")).toContain("example.com");
    });
});
