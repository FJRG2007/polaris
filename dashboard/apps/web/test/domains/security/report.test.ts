/**
 * The pieces around an audit: the grade, what counts as a regression worth
 * telling somebody about, a stored report read back after the code moved on,
 * who sent as a domain according to its DMARC reports, and the two wire-level
 * helpers (a zone transfer question, a DKIM key's size).
 */

import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { readReport } from "@/lib/domain-security/stored";
import { sendingSources } from "@/lib/domain-security/dmarc-sources";
import { axfrGranted, axfrQuery, keyBits } from "@/lib/domain-security/probes";
import { gradeOf, regressions, type Finding } from "@/lib/domain-security/types";

function finding(code: Finding["code"], severity: Finding["severity"], params: Finding["params"] = {}): Finding {
    return { code, severity, params, section: "email", records: [], where: null };
}

describe("grades and regressions", () => {
    it("grades by the worst finding", () => {
        expect(gradeOf([])).toBe("unknown");
        expect(gradeOf([finding("spfOk", "pass")])).toBe("protected");
        expect(gradeOf([finding("spfAllSoft", "low")])).toBe("fair");
        expect(gradeOf([finding("dmarcNone", "medium")])).toBe("weak");
        expect(gradeOf([finding("spfMissing", "high"), finding("spfOk", "pass")])).toBe("exposed");
    });

    it("tells only what is new or worse, and at least medium", () => {
        const before = [finding("dmarcNone", "medium"), finding("expirySoon", "medium")];
        const after = [finding("dmarcNone", "medium"), finding("expirySoon", "high"), finding("spfAllSoft", "low"), finding("dkimWeak", "high", { selector: "s1" })];
        expect(regressions(before, after).map((entry) => entry.code)).toEqual(["expirySoon", "dkimWeak"]);
        // The first audit tells about everything that matters.
        expect(regressions(null, before)).toHaveLength(2);
    });
});

describe("a stored report", () => {
    it("drops checks this code no longer has, and regrades what is left", () => {
        const report = readReport({
            domain: "example.com",
            checkedAt: "2026-10-01T00:00:00.000Z",
            sends: true,
            receives: true,
            rua: [],
            grade: "exposed",
            findings: [finding("spfOk", "pass"), { ...finding("spfOk", "pass"), code: "retiredCheck", severity: "critical" }]
        });
        expect(report?.findings.map((entry) => entry.code)).toEqual(["spfOk"]);
        expect(report?.grade).toBe("protected");
        expect(readReport({ nonsense: true })).toBeNull();
    });
});

describe("who sends as a domain", () => {
    const row = (sourceIp: string, count: number, verdict: "pass" | "fail", signedBy: string | null) => ({
        sourceIp,
        count,
        disposition: "none" as const,
        dkim: verdict,
        spf: verdict,
        headerFrom: "example.com",
        authDkim: signedBy ? [{ domain: signedBy, result: "pass", selector: "s1" }] : [],
        authSpf: []
    });

    it("tells a spoofer from a sender nobody finished setting up", () => {
        const sources = sendingSources([
            {
                orgName: "Example Receiver",
                reportId: "1",
                email: "",
                begin: new Date(0),
                end: new Date(0),
                domain: "example.com",
                policy: { p: "reject", sp: "reject", pct: 100 },
                rows: [row("192.0.2.1", 40, "pass", "example.com"), row("198.51.100.7", 5, "fail", null), row("203.0.113.9", 3, "fail", "esp.example.net")]
            }
        ]);
        expect(sources.map((source) => [source.sourceIp, source.verdict])).toEqual([
            ["198.51.100.7", "spoofing"],
            ["203.0.113.9", "misconfigured"],
            ["192.0.2.1", "authorized"]
        ]);
        expect(sources[2]).toMatchObject({ messages: 40, passed: 40, dkimDomains: ["example.com"] });
    });
});

describe("wire helpers", () => {
    it("asks for a zone transfer and reads whether one was given", () => {
        const query = axfrQuery("example.com");
        expect(query.readUInt16BE(0)).toBe(query.length - 2);
        // The question's type is AXFR (252), class IN.
        expect([...query.subarray(-4)]).toEqual([0, 252, 0, 1]);
        const answer = (rcode: number, answers: number) => {
            const body = Buffer.alloc(14);
            body.writeUInt16BE(12, 0);
            body[5] = 0x80 | rcode;
            body.writeUInt16BE(answers, 8);
            return body;
        };
        expect(axfrGranted(answer(0, 3))).toBe(true);
        expect(axfrGranted(answer(5, 0))).toBe(false);
        expect(axfrGranted(Buffer.alloc(4))).toBeNull();
    });

    it("measures an RSA DKIM key and knows an Ed25519 one", () => {
        const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
        const base64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
        expect(keyBits(base64, "rsa")).toBe(1024);
        expect(keyBits("AAAA", "ed25519")).toBe(256);
        expect(keyBits("bm90IGEga2V5", "rsa")).toBeNull();
    });
});
