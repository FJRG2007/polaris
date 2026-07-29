/**
 * Recognizing the DNS provider from a zone's nameservers. What is protected here is
 * the matching itself: a provider identified wrongly sends the operator to a panel
 * that does not hold their records, which is worse than not guessing at all - so the
 * real-world nameserver names are pinned, and an unknown one stays unknown.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every zone the walk asks about, so the lookups it makes can be asserted on. */
const asked: string[] = [];
const answers = new Map<string, string[]>();

vi.mock("node:dns/promises", () => ({
    Resolver: class {
        async resolveNs(zone: string): Promise<string[]> {
            asked.push(zone);
            const answer = answers.get(zone);
            if (!answer) throw new Error("ENOTFOUND");
            return answer;
        }
    }
}));

const { detectDnsProvider, dnsProviderFor } = await import("../../src/lib/dns-provider");

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

    it("does not let a fragment that ends on a whole label match deeper in the name", () => {
        // `ns1.name.com.br` contains `.name.com`, but it is a Brazilian nameserver and
        // has nothing to do with Name.com - offering its panel sends the operator to
        // records they cannot edit.
        expect(dnsProviderFor(["ns1.name.com.br", "ns2.name.com.br"])).toBeNull();
        expect(dnsProviderFor(["ns1.name.com"])?.id).toBe("name-com");
        expect(dnsProviderFor(["ns1.cloudflare.com.example"])).toBeNull();
        // Fragments that stop mid-label still match anywhere: the label they sit in
        // varies by shard or region.
        expect(dnsProviderFor(["ns-1520.awsdns-62.org"])?.id).toBe("route53");
        expect(dnsProviderFor(["ns1-01.azure-dns.cn"])?.id).toBe("azure");
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

describe("detectDnsProvider", () => {
    beforeEach(() => {
        asked.length = 0;
        answers.clear();
    });

    it("reports the zone that answers, walking up from a subdomain", async () => {
        answers.set("example.com", ["dana.ns.cloudflare.com", "rick.ns.cloudflare.com"]);
        const info = await detectDnsProvider("plr.example.com");
        expect(info?.id).toBe("cloudflare");
        expect(info?.zone).toBe("example.com");
        expect(asked).toEqual(["plr.example.com", "example.com"]);
    });

    it("stops at the registrable domain under a registry suffix", async () => {
        // `co.uk` answers with Nominet's own nameservers. Reporting those would name
        // the registry as the operator's provider and, because that answer is not
        // null, withdraw the offer to create the records for exactly the operator
        // whose domain does not resolve yet.
        answers.set("co.uk", ["dns1.nic.uk", "dns2.nic.uk"]);
        expect(await detectDnsProvider("example.co.uk")).toBeNull();
        expect(asked).toEqual(["example.co.uk"]);
    });

    it("still walks up to a registrable domain that a registry suffix sits above", async () => {
        answers.set("example.co.uk", ["dana.ns.cloudflare.com"]);
        const info = await detectDnsProvider("plr.example.co.uk");
        expect(info?.zone).toBe("example.co.uk");
        expect(asked).toEqual(["plr.example.co.uk", "example.co.uk"]);
    });

    it("keeps asking about a second-level domain the registry does sell", async () => {
        answers.set("example.uk", ["dana.ns.cloudflare.com"]);
        expect((await detectDnsProvider("example.uk"))?.id).toBe("cloudflare");
    });

    it("still looks up the domain that was typed when it reads as a registry suffix", async () => {
        // `me.io` is a domain somebody bought, not a label a registry delegates under -
        // and so are `id.me` and `net.io`. The rule only holds above the typed domain.
        answers.set("me.io", ["dana.ns.cloudflare.com"]);
        expect((await detectDnsProvider("me.io"))?.id).toBe("cloudflare");
        expect(asked).toEqual(["me.io"]);
    });

    it("walks a long name from its last labels instead of one lookup per label", async () => {
        // The hint runs from a server action on every pause in typing, and each lookup
        // that finds nothing waits out its own timeout: a name with a hundred labels
        // would hold the request open for minutes to find a zone that sits at the end.
        const deep = `${Array.from({ length: 40 }, (_, index) => `l${index}`).join(".")}.example.com`;
        answers.set("example.com", ["dana.ns.cloudflare.com"]);
        const info = await detectDnsProvider(deep);
        expect(info?.zone).toBe("example.com");
        expect(asked.length).toBeLessThanOrEqual(4);
    });

    it("answers null for a domain that does not exist yet, which keeps the offer open", async () => {
        expect(await detectDnsProvider("not-registered-yet.com")).toBeNull();
    });

    it("names the nameservers even where the provider is not one it knows", async () => {
        answers.set("example.com", ["ns1.some-tiny-registrar.example."]);
        const info = await detectDnsProvider("example.com");
        expect(info?.id).toBeNull();
        expect(info?.nameservers).toEqual(["ns1.some-tiny-registrar.example"]);
        expect(info?.automatable).toBe(false);
    });
});
