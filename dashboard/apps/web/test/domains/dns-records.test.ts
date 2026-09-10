/**
 * The DNS record editor: what a record may be, how the public resolvers are
 * asked about it, and the fence around a domain somebody brought.
 *
 * This machine has no working system resolver, and the resolvers are asked over
 * HTTPS anyway - so every answer here is a real DNS message built byte by byte and
 * handed back through a stubbed fetch, and nothing leaves the process.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- the zone-records fence runs against these ---------------------------------

const ZONE_ID = "0123456789abcdef0123456789abcdef";
const RECORD_ID = "fedcba9876543210fedcba9876543210";
const created: object[] = [];
let stored: { id: string; type: string; name: string } | null = null;

vi.mock("@polaris/db", () => ({
    prisma: {
        ownerDomain: {
            findFirst: async () => ({ domain: "shop.example.test", dnsToken: "sealed-token" })
        }
    }
}));
vi.mock("@/lib/tls/managed-certificates", () => ({ openText: (value: string | null) => value }));
vi.mock("@/lib/integrations/cloudflare-account-service", () => ({ loadCloudflareToken: async () => "instance-token" }));
vi.mock("@/lib/integrations/cloudflare-api", () => ({
    listZones: async () => [{ id: ZONE_ID, name: "example.test" }],
    resolveZoneForHostname: async () => ({ id: ZONE_ID, name: "example.test" }),
    listDnsRecords: async () => [],
    createDnsRecord: async (_token: string, _zone: string, record: object) => {
        created.push(record);
        return RECORD_ID;
    },
    updateDnsRecord: async () => undefined,
    deleteDnsRecord: async () => undefined,
    getDnsRecord: async () => stored
}));

const schema = await import("@/lib/dns/record-schema");
const propagation = await import("@/lib/dns/propagation");
const zones = await import("@/lib/dns/zone-records");

const { absoluteName, emptyDraft, recordFields, relativeName } = schema;
const { checkPropagation, decodeResponse, encodeQuery, base64Url } = propagation;

// --- building answers -----------------------------------------------------------

function nameBytes(name: string): number[] {
    const out: number[] = [];
    for (const label of name.split(".")) {
        const bytes = [...new TextEncoder().encode(label)];
        out.push(bytes.length, ...bytes);
    }
    out.push(0);
    return out;
}

function u16(value: number): number[] {
    return [value >> 8, value & 0xff];
}

/** A response to one question, with the answers given as (type, rdata) pairs.
 *  Every answer's owner name is a pointer back to the question, as real
 *  resolvers compress it. */
function response(name: string, qtype: number, answers: [number, number[]][], rcode = 0): Uint8Array {
    const header = [0, 0, 0x81, 0x80 | rcode, ...u16(1), ...u16(answers.length), 0, 0, 0, 0];
    const question = [...nameBytes(name), ...u16(qtype), 0, 1];
    const body: number[] = [];
    for (const [type, rdata] of answers) {
        body.push(0xc0, 12, ...u16(type), 0, 1, 0, 0, 0x0e, 0x10, ...u16(rdata.length), ...rdata);
    }
    return new Uint8Array([...header, ...question, ...body]);
}

function stubFetch(byResolver: Record<string, Uint8Array | "down">): typeof fetch {
    return (async (input: string | URL | Request) => {
        const url = String(input);
        const host = new URL(url).hostname;
        const answer = byResolver[host];
        if (!answer || answer === "down") throw new Error("unreachable");
        return new Response(answer, { status: 200, headers: { "content-type": "application/dns-message" } });
    }) as typeof fetch;
}

// --- tests ----------------------------------------------------------------------

describe("what a record may be", () => {
    const zone = "example.test";
    const draft = (overrides: Partial<ReturnType<typeof emptyDraft>>) => ({ ...emptyDraft(overrides.type ?? "A"), ...overrides });

    it("reads the name the way a registrar's form does", () => {
        expect(absoluteName("@", zone)).toBe("example.test");
        expect(absoluteName("", zone)).toBe("example.test");
        expect(absoluteName("WWW.", zone)).toBe("www.example.test");
        expect(absoluteName("www.example.test", zone)).toBe("www.example.test");
        expect(relativeName("example.test", zone)).toBe("@");
        expect(relativeName("api.example.test", zone)).toBe("api");
    });

    it("turns each type into the shape Cloudflare takes", () => {
        expect(recordFields(draft({ name: "www", content: "203.0.113.10", proxied: true }), zone)).toEqual({
            ok: true,
            record: { type: "A", name: "www.example.test", content: "203.0.113.10", ttl: 1, proxied: true }
        });
        expect(recordFields(draft({ type: "MX", name: "@", content: "MX.Example.test.", priority: "10", ttl: "300" }), zone)).toEqual({
            ok: true,
            record: { type: "MX", name: "example.test", content: "mx.example.test", priority: 10, ttl: 300 }
        });
        expect(
            recordFields(draft({ type: "SRV", name: "_minecraft._tcp", target: "mc.example.test", priority: "0", weight: "5", port: "25565" }), zone)
        ).toEqual({
            ok: true,
            record: {
                type: "SRV",
                name: "_minecraft._tcp.example.test",
                ttl: 1,
                data: { priority: 0, weight: 5, port: 25565, target: "mc.example.test" }
            }
        });
        expect(recordFields(draft({ type: "CAA", name: "@", tag: "issue", value: "letsencrypt.org" }), zone)).toEqual({
            ok: true,
            record: { type: "CAA", name: "example.test", ttl: 1, data: { flags: 0, tag: "issue", value: "letsencrypt.org" } }
        });
        expect(recordFields(draft({ type: "TXT", name: "_dmarc", content: " v=DMARC1; p=none " }), zone)).toMatchObject({
            ok: true,
            record: { type: "TXT", name: "_dmarc.example.test", content: "v=DMARC1; p=none" }
        });
        expect(recordFields(draft({ type: "AAAA", name: "v6", content: "2001:db8::10" }), zone)).toMatchObject({ ok: true });
    });

    it("says what is wrong, and reports an empty field as missing rather than wrong", () => {
        const empty = recordFields(draft({ name: "www", content: "" }), zone);
        expect(empty).toMatchObject({ ok: false, missing: ["content"] });
        expect(empty.ok ? {} : empty.problems).toEqual({});

        const wrong = recordFields(draft({ name: "www", content: "300.1.1.1" }), zone);
        expect(wrong.ok ? null : wrong.problems.content).toMatch(/IPv4/);
        expect(recordFields(draft({ type: "AAAA", name: "x", content: "203.0.113.1" }), zone).ok).toBe(false);
        expect(recordFields(draft({ type: "CNAME", name: "www", content: "www.example.test" }), zone).ok).toBe(false);
        expect(recordFields(draft({ name: "bad name", content: "203.0.113.1" }), zone).ok).toBe(false);
        expect(recordFields(draft({ type: "SRV", name: "minecraft", target: "mc.example.test", port: "1" }), zone).ok).toBe(false);
        expect(recordFields(draft({ name: "www", content: "203.0.113.1", ttl: "30" }), zone).ok).toBe(false);
        expect(recordFields(draft({ type: "MX", name: "@", content: "mx.example.test", priority: "70000" }), zone).ok).toBe(false);
    });

    it("lets Cloudflare set the TTL of a proxied record, and never proxies what cannot be", () => {
        const proxied = recordFields(draft({ name: "www", content: "203.0.113.1", proxied: true, ttl: "300" }), zone);
        expect(proxied.ok && proxied.record.ttl).toBe(1);
        const txt = recordFields(draft({ type: "TXT", name: "note", content: "hello", proxied: true }), zone);
        expect(txt.ok && "proxied" in txt.record).toBe(false);
    });
});

describe("asking a resolver", () => {
    it("writes a query as RFC 8484 expects: id zero, recursion desired, one question", () => {
        const query = encodeQuery("www.example.test", "A");
        expect([...query.slice(0, 12)]).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
        expect([...query.slice(12)]).toEqual([...nameBytes("www.example.test"), 0, 1, 0, 1]);
        expect(base64Url(new Uint8Array([251, 255]))).toBe("-_8");
    });

    it("reads every type the editor writes, through compressed names", () => {
        const a = response("example.test", 1, [[1, [203, 0, 113, 10]]]);
        expect(decodeResponse(a, "A")).toEqual({ rcode: 0, values: ["203.0.113.10"] });

        const aaaa = response("example.test", 28, [[28, [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10]]]);
        expect(decodeResponse(aaaa, "AAAA").values).toEqual(["2001:db8::10"]);

        // A long TXT value arrives as two strings; it is one value.
        const txt = response("example.test", 16, [[16, [3, ...new TextEncoder().encode("abc"), 2, ...new TextEncoder().encode("de")]]]);
        expect(decodeResponse(txt, "TXT").values).toEqual(["abcde"]);

        // MX pointing back at the question's own name by pointer.
        const mx = response("example.test", 15, [[15, [...u16(10), 2, ...new TextEncoder().encode("mx"), 0xc0, 12]]]);
        expect(decodeResponse(mx, "MX").values).toEqual(["10 mx.example.test"]);

        const srv = response("_mc._tcp.example.test", 33, [[33, [...u16(0), ...u16(5), ...u16(25565), ...nameBytes("mc.example.test")]]]);
        expect(decodeResponse(srv, "SRV").values).toEqual(["0 5 25565 mc.example.test"]);

        const caa = response("example.test", 257, [[257, [0, 5, ...new TextEncoder().encode("issue"), ...new TextEncoder().encode("letsencrypt.org")]]]);
        expect(decodeResponse(caa, "CAA").values).toEqual(['0 issue "letsencrypt.org"']);
    });

    it("keeps only the asked type out of an answer that follows an alias", () => {
        const answer = response("www.example.test", 1, [
            [5, nameBytes("edge.example.test")],
            [1, [198, 51, 100, 7]]
        ]);
        expect(decodeResponse(answer, "A").values).toEqual(["198.51.100.7"]);
    });

    it("refuses an answer whose name points in a circle instead of spinning", () => {
        const looping = new Uint8Array([0, 0, 0x81, 0x80, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 12, 0, 1, 0, 1]);
        expect(() => decodeResponse(looping, "A")).toThrow(/circle/);
    });
});

describe("whether a record has reached the resolvers", () => {
    const current = response("www.example.test", 1, [[1, [203, 0, 113, 10]]]);
    const stale = response("www.example.test", 1, [[1, [198, 51, 100, 1]]]);

    it("settles when every resolver gives what the zone holds", async () => {
        const report = await checkPropagation(
            "www.example.test",
            "A",
            ["203.0.113.10"],
            stubFetch({ "cloudflare-dns.com": current, "dns.google": current, "dns.quad9.net": current })
        );
        expect(report.settled).toBe(true);
        expect(report.resolvers.map((entry) => entry.agrees)).toEqual([true, true, true]);
    });

    it("names the resolver still giving the old answer, and the one that did not answer", async () => {
        const report = await checkPropagation(
            "www.example.test",
            "A",
            ["203.0.113.10"],
            stubFetch({ "cloudflare-dns.com": current, "dns.google": stale, "dns.quad9.net": "down" })
        );
        expect(report.settled).toBe(false);
        expect(report.resolvers).toMatchObject([
            { resolver: "cloudflare", status: "answered", agrees: true },
            { resolver: "google", status: "answered", values: ["198.51.100.1"], agrees: false },
            { resolver: "quad9", status: "unreachable", agrees: null }
        ]);
    });

    it("reads no such name as missing, not as a resolver failing", async () => {
        const missing = response("new.example.test", 1, [], 3);
        const report = await checkPropagation(
            "new.example.test",
            "A",
            ["203.0.113.10"],
            stubFetch({ "cloudflare-dns.com": missing, "dns.google": missing, "dns.quad9.net": missing })
        );
        expect(report.resolvers.every((entry) => entry.status === "missing" && entry.agrees === false)).toBe(true);
    });

    it("compares a proxied record's resolvers with each other", async () => {
        const report = await checkPropagation(
            "www.example.test",
            "A",
            null,
            stubFetch({ "cloudflare-dns.com": current, "dns.google": current, "dns.quad9.net": stale })
        );
        expect(report.resolvers.map((entry) => entry.agrees)).toEqual([true, true, false]);
    });

    it("expects what each type looks like on the wire", () => {
        expect(zones.expectedValues({ type: "MX", content: "MX.example.test.", proxied: false, priority: 10, data: null })).toEqual([
            "10 mx.example.test"
        ]);
        expect(
            zones.expectedValues({ type: "SRV", content: "", proxied: false, priority: null, data: { priority: 0, weight: 5, port: 25565, target: "mc.example.test" } })
        ).toEqual(["0 5 25565 mc.example.test"]);
        expect(zones.expectedValues({ type: "A", content: "203.0.113.10", proxied: true, priority: null, data: null })).toBeNull();
        // Cloudflare writes a TXT value quoted; the resolver gives it bare.
        expect(propagation.comparable('"v=spf1 -all"', "TXT")).toBe(propagation.comparable("v=spf1 -all", "TXT"));
    });
});

describe("a domain somebody brought", () => {
    const scope = { kind: "owner" as const, owner: { kind: "user" as const, id: "user-1" }, domainId: "od-1" };

    beforeEach(() => {
        created.length = 0;
        stored = null;
    });

    it("edits names at and under that domain only, even though its token reaches the zone", async () => {
        await zones.saveZoneRecord(scope, null, { ...emptyDraft("A"), name: "api.shop", content: "203.0.113.10" });
        expect(created).toEqual([{ type: "A", name: "api.shop.example.test", content: "203.0.113.10", ttl: 1, proxied: false }]);
        await expect(zones.saveZoneRecord(scope, null, { ...emptyDraft("A"), name: "www", content: "203.0.113.10" })).rejects.toThrow(
            /at or under shop\.example\.test/
        );
        expect(created).toHaveLength(1);
    });

    it("refuses to touch a record outside it by id", async () => {
        stored = { id: RECORD_ID, type: "A", name: "www.example.test" };
        await expect(zones.deleteZoneRecord(scope, RECORD_ID)).rejects.toThrow(/not in this zone/);
        await expect(zones.deleteZoneRecord(scope, "../../zones")).rejects.toThrow(/not in this zone/);
    });

    it("keeps an administrator to the zones the instance token reaches", async () => {
        await expect(zones.zoneRecords({ kind: "instance", zoneId: "ffffffffffffffffffffffffffffffff" })).rejects.toThrow(
            /can edit/
        );
        await expect(zones.zoneRecords({ kind: "instance", zoneId: "not-an-id" })).rejects.toThrow(/can edit/);
        expect((await zones.zoneRecords({ kind: "instance", zoneId: ZONE_ID })).zone.name).toBe("example.test");
    });
});
