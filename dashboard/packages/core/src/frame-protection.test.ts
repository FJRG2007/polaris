/**
 * Clickjacking protection. What matters is that the edge never loosens or replaces a
 * decision the app already made, and that nothing an operator types can reach a
 * response header in a shape that breaks it.
 */

import { describe, expect, it } from "vitest";
import { decodeGuardRule, encodeGuardRule } from "./waf.js";
import {
    cleanFrameAncestors,
    declaresFraming,
    fallbackFrameHeaders,
    frameAncestorsSchema,
    normalizeFrameOrigin,
    protectFrameHeaders
} from "./frame-protection.js";

describe("normalizeFrameOrigin", () => {
    it("keeps the origin and drops a path", () => {
        expect(normalizeFrameOrigin(" HTTPS://Partner.Example/page?x=1 ")).toBe("https://partner.example");
        expect(normalizeFrameOrigin("http://intranet.local:8080")).toBe("http://intranet.local:8080");
        expect(normalizeFrameOrigin("https://*.example.com")).toBe("https://*.example.com");
    });

    it("refuses what could break or widen the header", () => {
        for (const bad of [
            "example.com",
            "ftp://example.com",
            "https://exa mple.com",
            "https://example.com;script-src *",
            "https://'self'",
            "https://*.com",
            "https://example.com:0",
            "https://example.com:70000",
            "*"
        ]) {
            expect(normalizeFrameOrigin(bad), bad).toBeNull();
        }
    });

    it("validates and deduplicates a list", () => {
        expect(frameAncestorsSchema.parse(["https://a.example", "https://A.example/"])).toEqual(["https://a.example"]);
        expect(frameAncestorsSchema.safeParse(["nope"]).success).toBe(false);
        expect(cleanFrameAncestors(["https://a.example", 3, "bad", "https://b.example"])).toEqual([
            "https://a.example",
            "https://b.example"
        ]);
    });
});

describe("protectFrameHeaders", () => {
    it("adds both headers to a response that set neither", () => {
        expect(protectFrameHeaders({ "content-type": "text/html" }, [])).toEqual({
            "content-type": "text/html",
            "content-security-policy": ["frame-ancestors 'self'"],
            "x-frame-options": "SAMEORIGIN"
        });
    });

    it("appends a separate policy rather than editing the app's", () => {
        const out = protectFrameHeaders({ "content-security-policy": "default-src 'self'" }, []);

        expect(out["content-security-policy"]).toEqual(["default-src 'self'", "frame-ancestors 'self'"]);
    });

    it("leaves an app that set frame-ancestors exactly as it was", () => {
        const headers = { "content-security-policy": ["default-src 'self'", "frame-ancestors https://x.example"] };

        expect(protectFrameHeaders(headers, ["https://y.example"])).toBe(headers);
    });

    it("keeps an app's X-Frame-Options decision by stating it in CSP too", () => {
        // Without this, adding 'self' would loosen DENY: a browser ignores
        // X-Frame-Options once any frame-ancestors is present.
        expect(protectFrameHeaders({ "x-frame-options": "deny" }, [])["content-security-policy"]).toEqual([
            "frame-ancestors 'none'"
        ]);
        expect(protectFrameHeaders({ "x-frame-options": "SAMEORIGIN" }, ["https://x.example"])).toMatchObject({
            "content-security-policy": ["frame-ancestors 'self'"],
            "x-frame-options": "SAMEORIGIN"
        });
        const legacy = { "x-frame-options": "ALLOW-FROM https://x.example" };
        expect(protectFrameHeaders(legacy, [])).toBe(legacy);
    });

    it("names allowed sites and sends no X-Frame-Options, which cannot express them", () => {
        const out = protectFrameHeaders({}, ["https://a.example", "https://*.b.example"]);

        expect(out["content-security-policy"]).toEqual(["frame-ancestors 'self' https://a.example https://*.b.example"]);
        expect(out["x-frame-options"]).toBeUndefined();
    });
});

describe("the blind fallback", () => {
    it("is X-Frame-Options alone, and only with no extra site allowed", () => {
        expect(fallbackFrameHeaders([])).toEqual({ "X-Frame-Options": "SAMEORIGIN" });
        expect(fallbackFrameHeaders(["https://a.example"])).toEqual({});
        expect(fallbackFrameHeaders(undefined)).toEqual({});
    });

    it("knows when a service's own header settings already chose", () => {
        expect(declaresFraming({ "X-Frame-Options": "DENY" })).toBe(true);
        expect(declaresFraming({ "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'" })).toBe(true);
        expect(declaresFraming({ "Content-Security-Policy": "default-src 'self'" })).toBe(false);
    });
});

describe("the wire format", () => {
    const base = { deny: [], requireLogin: false, rules: [] };

    it("carries the allowed sites only while protection is on", () => {
        expect(decodeGuardRule(encodeGuardRule({ ...base, frameAncestors: [] })).frameAncestors).toEqual([]);
        expect(decodeGuardRule(encodeGuardRule({ ...base, frameAncestors: ["https://a.example"] })).frameAncestors).toEqual(
            ["https://a.example"]
        );
        expect(decodeGuardRule(encodeGuardRule(base)).frameAncestors).toBeUndefined();
    });

    it("drops an origin that does not normalise rather than echoing it", () => {
        const header = Buffer.from(JSON.stringify({ d: [], l: false, r: [], f: ["https://ok.example", "x; script-src *"] })).toString(
            "base64"
        );

        expect(decodeGuardRule(header).frameAncestors).toEqual(["https://ok.example"]);
    });
});
