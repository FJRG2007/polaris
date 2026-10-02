/**
 * Gathering a domain's facts through probes, with a fake network: what an
 * unanswered resolver becomes (unknown, never missing), how dangling aliases
 * and an empty wildcard DKIM key are found, and how much is asked.
 */

import { describe, expect, it } from "vitest";
import { collectFacts, MAX_ALIASES, type DnsAsk, type Probes } from "@/lib/domain-security/collect";

function fail(code: string): never {
    throw Object.assign(new Error(code), { code });
}

function dns(table: Record<string, Record<string, unknown>>, asked: string[] = []): DnsAsk {
    const look = (type: string) => async (name: string) => {
        asked.push(`${type} ${name}`);
        const answer = table[name]?.[type];
        if (answer === "TIMEOUT") fail("ETIMEOUT");
        if (answer === undefined) fail(table[name] ? "ENODATA" : "ENOTFOUND");
        return answer as never;
    };
    return {
        resolveMx: look("MX"),
        resolveTxt: look("TXT"),
        resolveNs: look("NS"),
        resolveCaa: look("CAA"),
        resolve4: look("A"),
        resolve6: look("AAAA"),
        resolveCname: look("CNAME")
    };
}

function probes(table: Record<string, Record<string, unknown>>, asked: string[] = []): Probes {
    return {
        dns: dns(table, asked),
        dnssec: async () => ({ present: false, validated: false }),
        axfr: async () => false,
        registration: async () => null,
        web: async () => null,
        mtaStsPolicy: async () => ({ status: "missing" }),
        keyBits: () => 2048,
        randomLabel: () => "polaris-random"
    };
}

const INPUT = {
    domain: "example.com",
    context: { polarisIssues: false, polarisZone: false, mailServerSpf: null, reportAddress: null, dsRecord: null },
    selectors: [],
    aliases: [],
    servedByPolaris: false
};

describe("collecting facts", () => {
    it("reads a resolver that did not answer as unknown, not as missing", async () => {
        const facts = await collectFacts(INPUT, probes({ "example.com": { TXT: "TIMEOUT", MX: "TIMEOUT", NS: "TIMEOUT" } }));
        expect(facts.apexTxt).toBeNull();
        expect(facts.mx).toBeNull();
        expect(facts.ns).toBeNull();
        // A name that does not exist is an answer: nothing is published there.
        expect(facts.dmarcTxt).toEqual([]);
    });

    it("finds an alias whose target is gone, and not one whose target only lacks IPv4", async () => {
        const facts = await collectFacts(
            {
                ...INPUT,
                aliases: [
                    { name: "old.example.com", target: "gone.example.net" },
                    { name: "v6.example.com", target: "v6only.example.net" },
                    { name: "www.example.com" }
                ]
            },
            probes({
                "v6only.example.net": { AAAA: ["2001:db8::1"] },
                "www.example.com": { CNAME: ["live.example.net"] },
                "live.example.net": { A: ["192.0.2.10"] }
            })
        );
        expect(facts.dangling).toEqual([{ name: "old.example.com", target: "gone.example.net" }]);
        expect(facts.danglingChecked).toBe(3);
    });

    it("checks at most a bounded number of aliases", async () => {
        const aliases = Array.from({ length: MAX_ALIASES + 10 }, (_, index) => ({ name: `a${index}.example.com`, target: "live.example.net" }));
        const facts = await collectFacts({ ...INPUT, aliases }, probes({ "live.example.net": { A: ["192.0.2.10"] } }));
        expect(facts.danglingChecked).toBe(MAX_ALIASES);
    });

    it("finds the empty wildcard DKIM key a locked-down domain publishes", async () => {
        const facts = await collectFacts(INPUT, probes({ "polaris-random._domainkey.example.com": { TXT: [["v=DKIM1; p="]] } }));
        expect(facts.dkim).toEqual([{ selector: "*", text: "v=DKIM1; p=", bits: null }]);
    });

    it("measures each DKIM key it finds, and tries Polaris's own selectors first", async () => {
        const asked: string[] = [];
        const facts = await collectFacts(
            { ...INPUT, selectors: ["polaris"] },
            probes({ "polaris._domainkey.example.com": { TXT: [["v=DKIM1; k=rsa; p=MIIB"]] } }, asked)
        );
        expect(facts.dkim).toEqual([{ selector: "polaris", text: "v=DKIM1; k=rsa; p=MIIB", bits: 2048 }]);
        expect(facts.dkimSelectorsTried[0]).toBe("polaris");
        expect(asked.filter((entry) => entry.includes("._domainkey.")).length).toBe(facts.dkimSelectorsTried.length);
    });

    it("asks report hosts outside the domain whether they accept its reports", async () => {
        const facts = await collectFacts(
            INPUT,
            probes({
                "_dmarc.example.com": { TXT: [["v=DMARC1; p=reject; rua=mailto:a@example.com,mailto:b@reports.example.net"]] },
                "example.com._report._dmarc.reports.example.net": { TXT: [["v=DMARC1"]] }
            })
        );
        expect(facts.ruaAuthorization).toEqual({ "reports.example.net": true });
    });
});
