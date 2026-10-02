/**
 * Reading the records a domain's security is published in: SPF and its lookup
 * budget, DMARC, DKIM keys, an MTA-STS policy and a security.txt. Each reader is
 * fed the text a resolver or a server gives, and has to say exactly what is
 * wrong with a bad one.
 */

import { describe, expect, it } from "vitest";
import * as rec from "@/lib/domain-security/records";

describe("SPF", () => {
    it("reads the mechanisms, the all qualifier and a redirect", () => {
        const spf = rec.parseSpf("v=spf1 include:_spf.example.net ip4:192.0.2.0/24 ip6:2001:db8::/32 mx -all");
        expect(spf).toMatchObject({ ok: true, all: "-", redirect: null });
        expect(spf.ok && spf.terms.map((term) => term.mechanism)).toEqual(["include", "ip4", "ip6", "mx", "all"]);
        expect(rec.parseSpf("v=spf1 redirect=_spf.example.net")).toMatchObject({ ok: true, all: null, redirect: "_spf.example.net" });
    });

    it("names the term that does not parse", () => {
        expect(rec.parseSpf("v=spf1 include: -all")).toEqual({ ok: false, bad: "include:" });
        expect(rec.parseSpf("v=spf1 ip4:300.1.1.1 -all")).toEqual({ ok: false, bad: "ip4:300.1.1.1" });
        expect(rec.parseSpf("v=spf1 a:example.com bogus -all")).toEqual({ ok: false, bad: "bogus" });
        expect(rec.parseSpf("v=spf2 -all")).toEqual({ ok: false, bad: "v=spf2" });
    });

    it("tells an SPF that authorizes somebody from one that allows nobody", () => {
        const none = rec.parseSpf("v=spf1 -all");
        const some = rec.parseSpf("v=spf1 mx ~all");
        expect(none.ok && rec.spfAuthorizesSenders(none)).toBe(false);
        expect(some.ok && rec.spfAuthorizesSenders(some)).toBe(true);
    });

    it("merges two records into one, keeping the first record's all", () => {
        expect(rec.mergeSpfRecords("v=spf1 include:a.example -all", "v=spf1 include:b.example include:a.example ~all")).toBe(
            "v=spf1 include:a.example include:b.example -all"
        );
        expect(rec.mergeSpfRecords("v=spf1 mx", "v=spf1 ip4:192.0.2.1")).toBe("v=spf1 mx ip4:192.0.2.1 ~all");
    });
});

describe("the SPF lookup walk", () => {
    function resolver(txt: Record<string, string[]>, existing: string[] = []): rec.SpfResolver {
        return {
            txt: async (name) => txt[name] ?? [],
            exists: async (name) => existing.includes(name)
        };
    }

    it("counts nested includes, and stops on a loop", async () => {
        const spf = rec.parseSpf("v=spf1 include:a.example include:b.example -all");
        if (!spf.ok) throw new Error("unreadable");
        const walk = await rec.walkSpf(
            "example.com",
            spf,
            resolver({
                "a.example": ["v=spf1 include:c.example ~all"],
                "b.example": ["v=spf1 ip4:192.0.2.1 ~all"],
                "c.example": ["v=spf1 include:a.example ~all"]
            })
        );
        // a, b, c, and c's include of a (counted, not followed again).
        expect(walk).toEqual({ lookups: 4, voids: 0, missing: [], broken: [] });
    });

    it("reports an include with no SPF, and lookups that found nothing", async () => {
        const spf = rec.parseSpf("v=spf1 include:gone.example a:nowhere.example mx -all");
        if (!spf.ok) throw new Error("unreadable");
        const walk = await rec.walkSpf("example.com", spf, resolver({}, []));
        expect(walk.missing).toEqual(["gone.example"]);
        expect(walk.voids).toBe(3);
        expect(walk.lookups).toBe(3);
    });

    it("stops asking once the budget is spent", async () => {
        const includes = Array.from({ length: 30 }, (_, index) => `include:i${index}.example`).join(" ");
        const spf = rec.parseSpf(`v=spf1 ${includes} -all`);
        if (!spf.ok) throw new Error("unreadable");
        const asked: string[] = [];
        const walk = await rec.walkSpf("example.com", spf, {
            txt: async (name) => {
                asked.push(name);
                return ["v=spf1 -all"];
            },
            exists: async () => true
        });
        expect(walk.lookups).toBe(20);
        expect(asked.length).toBe(20);
    });
});

describe("DMARC", () => {
    it("reads the policy and fills in the defaults", () => {
        expect(rec.parseDmarc("v=DMARC1; p=reject; rua=mailto:dmarc@example.com!10m")).toEqual({
            ok: true,
            record: { p: "reject", sp: "reject", spSet: false, pct: 100, adkim: "r", aspf: "r", rua: ["mailto:dmarc@example.com"], ruf: [] }
        });
        expect(rec.parseDmarc("v=DMARC1; p=quarantine; sp=none; pct=25; adkim=s")).toMatchObject({
            ok: true,
            record: { p: "quarantine", sp: "none", spSet: true, pct: 25, adkim: "s" }
        });
    });

    it("refuses a record a receiver would ignore", () => {
        expect(rec.parseDmarc("v=DMARC1; p=block")).toEqual({ ok: false, bad: "p=block" });
        expect(rec.parseDmarc("v=DMARC1; rua=mailto:a@b")).toEqual({ ok: false, bad: "p=" });
        expect(rec.parseDmarc("v=DMARC1; p=none; pct=150")).toEqual({ ok: false, bad: "pct=150" });
    });

    it("changes the policy or adds a report address and keeps every other tag", () => {
        const text = "v=DMARC1; p=none; rua=mailto:a@example.com; fo=1";
        expect(rec.withPolicy(text, "quarantine")).toBe("v=DMARC1; p=quarantine; rua=mailto:a@example.com; fo=1");
        expect(rec.withRua(text, "mailto:b@example.com")).toBe("v=DMARC1; p=none; rua=mailto:a@example.com,mailto:b@example.com; fo=1");
        expect(rec.withRua("v=DMARC1; p=none", "mailto:b@example.com")).toBe("v=DMARC1; p=none; rua=mailto:b@example.com");
        expect(rec.withRua(text, "mailto:A@example.com")).toBe(text);
    });

    it("writes a record the reader reads back", () => {
        const text = rec.formatDmarc({ p: "reject", sp: "reject", adkim: "s", aspf: "s", rua: ["mailto:r@example.com"] });
        expect(text).toBe("v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s; rua=mailto:r@example.com");
        expect(rec.parseDmarc(text).ok).toBe(true);
    });
});

describe("DKIM, MTA-STS and security.txt", () => {
    it("reads a key, a revoked key and test mode", () => {
        expect(rec.parseDkim("v=DKIM1; k=rsa; t=y; p=MIIB AQAB")).toEqual({ keyType: "rsa", publicKey: "MIIBAQAB", testing: true });
        expect(rec.parseDkim("v=DKIM1; p=")).toEqual({ keyType: "rsa", publicKey: "", testing: false });
        expect(rec.parseDkim("not a key")).toBeNull();
    });

    it("reads an MTA-STS policy and matches MX hosts against it", () => {
        const policy = rec.parseMtaStsPolicy("version: STSv1\nmode: enforce\nmx: mail.example.com\nmx: *.backup.example.net\nmax_age: 604800\n");
        expect(policy).toEqual({ mode: "enforce", mx: ["mail.example.com", "*.backup.example.net"], maxAge: 604800 });
        expect(rec.mxCovered("mx1.backup.example.net", policy!.mx)).toBe(true);
        expect(rec.mxCovered("a.b.backup.example.net", policy!.mx)).toBe(false);
        expect(rec.mxCovered("other.example.com", policy!.mx)).toBe(false);
        expect(rec.parseMtaStsPolicy("version: STSv1\nmode: enforce\nmax_age: 1\n")).toBeNull();
    });

    it("reads a security.txt's contact and expiry", () => {
        expect(rec.parseSecurityTxt("# hi\nContact: mailto:security@example.com\nExpires: 2027-01-01T00:00:00Z\n")).toEqual({
            contacts: ["mailto:security@example.com"],
            expires: "2027-01-01T00:00:00.000Z"
        });
        expect(rec.parseSecurityTxt("<html>not found</html>")).toBeNull();
    });
});
