import { describe, expect, it } from "vitest";
import {
    createWafBlockLog,
    isWafBlockReference,
    parseWafBlockRecord,
    wafBlockLookupAllowed,
    wafBlockLookupToken,
    type WafBlockRecord
} from "../src/waf-block-log.js";

const REF = "3418858b-784f-463f-84ef-8b9013fbd592";

function record(reference: string): WafBlockRecord {
    return {
        reference,
        reason: "intel: ban",
        ip: "203.0.113.5",
        host: "polaris.example.com",
        uri: "/",
        method: "GET",
        userAgent: "test",
        at: "2026-11-12T00:00:00.000Z"
    };
}

describe("the guard's block log", () => {
    it("finds a block by its reference", () => {
        const log = createWafBlockLog(3);
        log.add(record(REF));
        expect(log.find(REF)?.reason).toBe("intel: ban");
        expect(log.find("00000000-0000-0000-0000-000000000000")).toBeNull();
    });

    it("forgets the oldest once it is full, and stays that size", () => {
        const log = createWafBlockLog(2);
        const refs = ["a", "b", "c"].map((c) => `${c.repeat(8)}-0000-0000-0000-000000000000`);
        for (const ref of refs) log.add(record(ref));
        expect(log.size).toBe(2);
        expect(log.find(refs[0]!)).toBeNull();
        expect(log.find(refs[2]!)).not.toBeNull();
    });
});

describe("the lookup bearer", () => {
    it("lets Polaris in with the shared secret and nobody else", () => {
        const token = wafBlockLookupToken("secret");
        expect(wafBlockLookupAllowed(`Bearer ${token}`, "secret")).toBe(true);
        expect(wafBlockLookupAllowed(`Bearer ${token}`, "other")).toBe(false);
        expect(wafBlockLookupAllowed(token, "secret")).toBe(false);
        expect(wafBlockLookupAllowed(undefined, "secret")).toBe(false);
    });

    it("answers nobody when the guard has no secret", () => {
        expect(wafBlockLookupAllowed(`Bearer ${wafBlockLookupToken("")}`, "")).toBe(false);
    });
});

describe("parseWafBlockRecord", () => {
    it("keeps a record and drops what is not one", () => {
        expect(parseWafBlockRecord({ ...record(REF), extra: 1 })).toEqual(record(REF));
        expect(parseWafBlockRecord({ reference: "nope", at: "2026-11-12T00:00:00Z" })).toBeNull();
        expect(parseWafBlockRecord({ reference: REF, at: "never" })).toBeNull();
        expect(parseWafBlockRecord("text")).toBeNull();
    });

    it("recognises the reference shape", () => {
        expect(isWafBlockReference(REF)).toBe(true);
        expect(isWafBlockReference(REF.toUpperCase())).toBe(false);
    });
});
