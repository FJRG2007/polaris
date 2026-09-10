/**
 * The one schema a DNS record is checked with, by the editor as it is typed and
 * by the server before anything reaches Cloudflare.
 *
 * What is pinned: each type's own rules, that a name and a value are normalized
 * before they are judged (and never patched into validity), and the checks that
 * need the rest of the zone - a second copy of a record, and a CNAME sharing its
 * name with anything at all.
 */

import { describe, expect, it } from "vitest";
import * as dns from "@/lib/dns/record-schema";

const zone = "example.test";

function draft(overrides: Partial<dns.DnsRecordDraft>): dns.DnsRecordDraft {
    return { ...dns.emptyDraft(overrides.type ?? "A"), name: "www", ...overrides };
}

/** The sentence a field is refused with, or undefined when it is not. */
function problem(value: dns.DnsRecordDraft, field: keyof dns.DnsRecordDraft, checks?: dns.RecordChecks) {
    const checked = dns.recordFields(value, zone, checks);
    return checked.ok ? undefined : checked.problems[field];
}

/** A record the zone already holds, in the shape the editor reads it. */
function existing(id: string, type: dns.DnsRecordType, name: string, overrides: Partial<dns.DnsRecordDraft>): dns.ExistingRecord {
    const record = { ...dns.emptyDraft(type), name: dns.relativeName(name, zone), ...overrides };
    return { id, type, name, content: record.content, draft: record };
}

describe("normalizing before checking", () => {
    it("trims, lower-cases names and hostnames, and drops a final dot", () => {
        expect(dns.normalizeDraft(draft({ type: "CNAME", name: "  WWW.Example.Test. ", content: " Edge.Example.NET. " }))).toMatchObject({
            name: "www.example.test",
            content: "edge.example.net"
        });
        // TXT text is the one value whose case is its own.
        expect(dns.normalizeDraft(draft({ type: "TXT", content: "  v=DKIM1; p=AbC  " })).content).toBe("v=DKIM1; p=AbC");
        expect(dns.normalizeDraft(draft({ type: "SRV", target: " MC.Example.Test. ", port: " 25565 " }))).toMatchObject({
            target: "mc.example.test",
            port: "25565"
        });
    });

    it("stores a name relative to the zone, whichever way it was typed", () => {
        const record = (name: string) => dns.recordFields(draft({ name, content: "203.0.113.10" }), zone);
        for (const typed of ["api", "API.", "api.example.test", " Api.Example.Test. "]) {
            expect(record(typed)).toMatchObject({ ok: true, record: { name: "api.example.test" } });
        }
        expect(record("@")).toMatchObject({ ok: true, record: { name: "example.test" } });
    });

    it("never patches a wrong value into a right one", () => {
        expect(problem(draft({ name: "my host" }), "name")).toMatch(/Letters, digits and hyphens/);
        expect(problem(draft({ content: "203.0.113.10 " }), "content")).toBeUndefined();
        expect(problem(draft({ content: "203.0.113 .10" }), "content")).toMatch(/IPv4/);
    });
});

describe("each type's own rules", () => {
    it("A takes an IPv4 address and nothing else", () => {
        expect(problem(draft({ content: "203.0.113.10" }), "content")).toBeUndefined();
        for (const wrong of ["300.1.1.1", "203.0.113", "2001:db8::1", "example.test"]) {
            expect(problem(draft({ content: wrong }), "content")).toBe("An IPv4 address, like 203.0.113.10");
        }
    });

    it("AAAA takes an IPv6 address and nothing else", () => {
        expect(problem(draft({ type: "AAAA", content: "2001:DB8::10" }), "content")).toBeUndefined();
        for (const wrong of ["203.0.113.10", "2001:db8::zz", "fe80::1%eth0"]) {
            expect(problem(draft({ type: "AAAA", content: wrong }), "content")).toMatch(/IPv6/);
        }
    });

    it("CNAME, MX and NS point at a hostname", () => {
        expect(problem(draft({ type: "CNAME", content: "edge.example.net" }), "content")).toBeUndefined();
        expect(problem(draft({ type: "CNAME", content: "203.0.113.10:80" }), "content")).toMatch(/hostname/);
        expect(problem(draft({ type: "CNAME", content: "www.example.test" }), "content")).toBe("A name cannot point at itself");
        expect(problem(draft({ type: "MX", name: "@", content: "mx_1.example.test" }), "content")).toMatch(/mail server/);
        expect(problem(draft({ type: "NS", name: "lab", content: "ns1.example.net" }), "content")).toBeUndefined();
        expect(problem(draft({ type: "NS", name: "lab", content: "*.example.net" }), "content")).toMatch(/nameserver/);
    });

    it("keeps the domain's own nameservers Cloudflare's", () => {
        expect(problem(draft({ type: "NS", name: "@", content: "ns1.example.net" }), "name")).toMatch(/set by Cloudflare/);
    });

    it("MX priority is 0 to 65535", () => {
        expect(problem(draft({ type: "MX", name: "@", content: "mx.example.test", priority: "0" }), "priority")).toBeUndefined();
        expect(problem(draft({ type: "MX", name: "@", content: "mx.example.test", priority: "65536" }), "priority")).toBe("0 to 65535");
        expect(problem(draft({ type: "MX", name: "@", content: "mx.example.test", priority: "-1" }), "priority")).toBe("0 to 65535");
    });

    it("TXT holds one line of up to Cloudflare's limit", () => {
        expect(problem(draft({ type: "TXT", content: "a".repeat(dns.TXT_MAX) }), "content")).toBeUndefined();
        expect(problem(draft({ type: "TXT", content: "a".repeat(dns.TXT_MAX + 1) }), "content")).toBe(`At most ${dns.TXT_MAX} characters`);
        expect(problem(draft({ type: "TXT", content: "v=spf1\n-all" }), "content")).toMatch(/line breaks/);
    });

    it("SRV is named for a service and a protocol, with a target and three numbers", () => {
        const srv = (overrides: Partial<dns.DnsRecordDraft>) =>
            draft({ type: "SRV", name: "_minecraft._tcp", target: "mc.example.test", priority: "0", weight: "5", port: "25565", ...overrides });
        expect(dns.recordFields(srv({}), zone)).toMatchObject({
            ok: true,
            record: { type: "SRV", data: { priority: 0, weight: 5, port: 25565, target: "mc.example.test" } }
        });
        expect(problem(srv({ name: "minecraft" }), "name")).toMatch(/_service\._protocol/);
        expect(problem(srv({ port: "70000" }), "port")).toBe("0 to 65535");
        expect(problem(srv({ target: "not a host" }), "target")).toMatch(/hostname/);
    });

    it("CAA names an authority, or ; to allow none, or an address to report to", () => {
        const caa = (overrides: Partial<dns.DnsRecordDraft>) => draft({ type: "CAA", name: "@", ...overrides });
        expect(problem(caa({ value: "letsencrypt.org" }), "value")).toBeUndefined();
        expect(problem(caa({ value: ";" }), "value")).toBeUndefined();
        expect(problem(caa({ value: "letsencrypt.org; validationmethods=dns-01" }), "value")).toBeUndefined();
        expect(problem(caa({ value: "lets encrypt" }), "value")).toMatch(/A domain/);
        expect(problem(caa({ tag: "iodef", value: "mailto:security@example.test" }), "value")).toBeUndefined();
        expect(problem(caa({ tag: "iodef", value: "security@example.test" }), "value")).toMatch(/mailto:/);
        expect(problem(caa({ value: "letsencrypt.org", flags: "256" }), "flags")).toBe("0 to 255");
    });

    it("takes Auto or a TTL in range, and Auto whenever the proxy is on", () => {
        expect(problem(draft({ content: "203.0.113.10", ttl: "300" }), "ttl")).toBeUndefined();
        expect(problem(draft({ content: "203.0.113.10", ttl: "30" }), "ttl")).toMatch(/Auto, or 60 to 86400/);
        expect(problem(draft({ content: "203.0.113.10", ttl: "90000" }), "ttl")).toMatch(/Auto/);
        const proxied = dns.recordFields(draft({ content: "203.0.113.10", ttl: "30", proxied: true }), zone);
        expect(proxied).toMatchObject({ ok: true, record: { ttl: dns.TTL_AUTO, proxied: true } });
    });

    it("reports a field nobody has filled in as missing rather than wrong", () => {
        const empty = dns.recordFields(draft({ name: "", content: "" }), zone);
        expect(empty).toEqual({ ok: false, problems: {}, missing: ["name", "content"] });
    });

    it("keeps an owner's records at or under the domain they proved", () => {
        const within = { within: "shop.example.test" };
        expect(problem(draft({ name: "api.shop", content: "203.0.113.10" }), "name", within)).toBeUndefined();
        expect(problem(draft({ name: "www", content: "203.0.113.10" }), "name", within)).toBe("Must be at or under shop.example.test");
    });
});

describe("checked against the zone", () => {
    const zoneRecords = [
        existing("a1", "A", "www.example.test", { content: "203.0.113.10" }),
        existing("c1", "CNAME", "blog.example.test", { content: "blog.host.example.net" }),
        existing("t1", "TXT", "example.test", { content: '"v=spf1 -all"' }),
        existing("m1", "MX", "example.test", { content: "mx.example.test", priority: "10" })
    ];
    const checks = { existing: zoneRecords };

    it("refuses a second copy of a record, however it was typed", () => {
        expect(problem(draft({ name: "WWW.", content: " 203.0.113.10 " }), "content", checks)).toBe("This A record is already in the zone");
        // A different address at the same name is a second record, not a copy.
        expect(problem(draft({ content: "203.0.113.11" }), "content", checks)).toBeUndefined();
        // Cloudflare writes TXT values quoted; the text inside is what is compared.
        expect(problem(draft({ type: "TXT", name: "@", content: "v=spf1 -all" }), "content", checks)).toMatch(/already in the zone/);
        // A priority is a setting of the one record, not a second one.
        expect(problem(draft({ type: "MX", name: "@", content: "mx.example.test", priority: "20" }), "content", checks)).toMatch(
            /already in the zone/
        );
    });

    it("lets a record be saved over itself", () => {
        const edit = dns.recordFields(draft({ content: "203.0.113.10", ttl: "300" }), zone, { ...checks, editingId: "a1" });
        expect(edit.ok).toBe(true);
    });

    it("keeps a CNAME alone at its name, both ways round", () => {
        expect(problem(draft({ type: "CNAME", content: "edge.example.net" }), "name", checks)).toBe(
            "www already has an A record, and a CNAME cannot share its name"
        );
        expect(problem(draft({ name: "blog", content: "203.0.113.10" }), "name", checks)).toBe(
            "blog is a CNAME, which cannot share its name with other records"
        );
        expect(problem(draft({ type: "CNAME", name: "blog", content: "other.example.net" }), "name", checks)).toMatch(/CNAME/);
        // Changing the CNAME itself is not a conflict with itself.
        expect(problem(draft({ type: "CNAME", name: "blog", content: "other.example.net" }), "name", { ...checks, editingId: "c1" })).toBeUndefined();
    });

    it("counts every TXT record at a name against Cloudflare's total", () => {
        const long = (id: string) => existing(id, "TXT", "big.example.test", { content: "a".repeat(dns.TXT_MAX) });
        const full = { existing: [long("t1"), long("t2"), long("t3"), long("t4")] };
        expect(problem(draft({ type: "TXT", name: "big", content: "b" }), "content", full)).toMatch(/add up to more than 8192/);
    });

    it("compares only a record that is right on its own", () => {
        // A half-typed value says nothing about duplicates; the field's own problem wins.
        expect(problem(draft({ content: "203.0.113" }), "content", checks)).toMatch(/IPv4/);
    });
});

describe("the server's shape check", () => {
    it("refuses what a form could not have sent", () => {
        expect(dns.dnsRecordDraftSchema.safeParse({ ...dns.emptyDraft("A"), type: "PTR" }).success).toBe(false);
        expect(dns.dnsRecordDraftSchema.safeParse({ ...dns.emptyDraft("A"), name: "a".repeat(300) }).success).toBe(false);
        expect(dns.dnsRecordDraftSchema.safeParse({ ...dns.emptyDraft("A"), proxied: "yes" }).success).toBe(false);
    });
});
