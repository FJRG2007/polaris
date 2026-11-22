/**
 * What a block tells the visitor. A connection property they can change is named; what
 * the request carried, or which rule caught it, never is - that would tell a scanner
 * what to change. These hold the line, per cause, in every language the page speaks.
 */

import { describe, expect, it } from "vitest";
import { wafBlockPage } from "../src/waf-block-page.js";
import { parseWafBlockRecord } from "../src/waf-block-log.js";
import { indexWafIntel, WAF_INTEL_VERSION } from "../src/waf-intel.js";
import {
    WAF_BLOCK_CAUSES,
    wafBlockJson,
    wafBlockLocale,
    wafBlockSentence,
    wafIntelCause
} from "../src/waf-block-cause.js";

const REFERENCE = "2f9a1c5e-7b64-4c2f-9a3d-16b0c8f4e7d1";
const GENERIC = "This site runs a firewall.";

describe("wafIntelCause", () => {
    it.each([
        [{ reason: "tor" }, "tor"],
        [{ reason: "reputation", note: "Tor" }, "tor"],
        [{ reason: "reputation", note: "TOR_NETWORK" }, "tor"],
        [{ reason: "reputation", note: "VPN" }, "anonymizer"],
        [{ reason: "reputation", note: "PROXY" }, "anonymizer"],
        [{ reason: "reputation", note: "Hosting or datacenter" }, "hosting"],
        [{ reason: "ban", source: "rate-limited", note: "Rate-limit flood: 5 in 10m" }, "rate_limited"]
    ])("names %j as %s", (entry, cause) => {
        expect(wafIntelCause(entry)).toBe(cause);
    });

    it.each([
        { reason: "reputation", note: "Known scanner" },
        { reason: "reputation", note: "Known malicious" },
        { reason: "reputation", note: "HIGH_RISK_SCORE" },
        { reason: "reputation", note: "FRAUD" },
        { reason: "reputation", note: "Inbound score Dangerous" },
        { reason: "reputation", note: "torrent client seen" },
        { reason: "ban", source: "probes", note: "Exploit probing: 3 in 1m" },
        { reason: "ban", source: "not-found", note: "Missing-page flood: 9 in 5m" },
        { reason: "manual", source: "anomaly", note: "VPN" }
    ])("leaves %j to the caller", (entry) => {
        expect(wafIntelCause(entry)).toBeNull();
    });

    it("travels through the snapshot, and a cause the guard does not know is dropped", () => {
        const index = indexWafIntel({
            v: WAF_INTEL_VERSION,
            at: 0,
            ips: {
                "198.51.100.1": { reason: "reputation", until: null, cause: "anonymizer" },
                "198.51.100.2": { reason: "reputation", until: null, cause: "<script>" }
            },
            cidrs: [],
            moved: {}
        });
        expect(index.match("198.51.100.1", 0)?.cause).toBe("anonymizer");
        expect(index.match("198.51.100.2", 0)?.cause).toBeUndefined();
    });
});

describe("the block page, per cause", () => {
    it("tells a Tor visitor to use a regular browser and connection", () => {
        const page = wafBlockPage({ reference: REFERENCE, cause: "tor", ip: "192.42.116.98" });
        expect(page).toContain(
            "Access through Tor is blocked on this site for security. Open it from a regular browser and connection."
        );
        expect(page).not.toContain(GENERIC);
        expect(page).toContain("192.42.116.98");
        expect(page).toContain(REFERENCE);
    });

    it.each([
        ["anonymizer", "VPN, proxy or anonymizing service"],
        ["hosting", "hosting and datacenter networks"],
        ["ip_banned", "The owner of this site has blocked your IP address."],
        ["account_refused", "Your account has been blocked from this service."],
        ["account_not_admitted", "Your account does not have access to this service."]
    ] as const)("names %s", (cause, words) => {
        expect(wafBlockPage({ reference: REFERENCE, cause })).toContain(words);
    });

    it("says when a rate limit lets the visitor try again", () => {
        const until = Date.parse("2026-11-22T10:00:00.000Z");
        const page = wafBlockPage({ reference: REFERENCE, cause: "rate_limited", until });
        expect(page).toContain("Too many requests came from your address");
        expect(page).toContain('datetime="2026-11-22T10:00:00.000Z"');
        expect(page).toContain("Try again after");
    });

    it("says when a timed ban lifts, and keeps the sign-in way out", () => {
        const until = Date.parse("2026-11-22T10:00:00.000Z");
        const page = wafBlockPage({
            reference: REFERENCE,
            cause: "temporary_ban",
            release: { until, signIn: "/oauth/login" }
        });
        expect(page).toContain("blocked automatically");
        expect(page).toContain("It is unblocked by itself at");
        expect(page).toContain('href="/oauth/login"');
    });

    it("does not present a reputation verdict's expiry as when the block lifts", () => {
        const page = wafBlockPage({
            reference: REFERENCE,
            cause: "anonymizer",
            release: { until: Date.parse("2026-11-22T10:00:00.000Z"), signIn: "/oauth/login" }
        });
        expect(page).not.toContain("edge-until");
        expect(page).not.toContain("blocked automatically");
        expect(page).toContain("sign in");
    });

    it("keeps a block that would help an attacker generic", () => {
        for (const page of [
            wafBlockPage({ reference: REFERENCE }),
            wafBlockPage({ reference: REFERENCE, cause: "firewall" }),
            wafBlockPage({ reference: REFERENCE, cause: "custom" })
        ]) {
            expect(page.toLowerCase()).not.toContain("injection");
            expect(page.toLowerCase()).not.toContain("tor ");
            expect(page).toContain("If the site is yours, review its firewall rules.");
        }
    });

    it("shows the owner's message for a custom rule, escaped", () => {
        const page = wafBlockPage({
            reference: REFERENCE,
            cause: "custom",
            message: 'Partners only - write to <b>"ops"</b> for access.'
        });
        expect(page).toContain("Partners only - write to &lt;b&gt;&quot;ops&quot;&lt;/b&gt; for access.");
        expect(page).not.toContain("<b>");
    });

    it("falls back to a generic sentence for a custom cause with an empty message", () => {
        const page = wafBlockPage({ reference: REFERENCE, cause: "custom", message: "   " });
        expect(page).toContain("one of its rules blocks this request");
    });
});

describe("localization", () => {
    it("speaks Spanish to a Spanish browser, and English to anyone else", () => {
        expect(wafBlockLocale("es-ES,es;q=0.9,en;q=0.8").locale).toBe("es-ES");
        expect(wafBlockLocale("es-MX").locale).toBe("es-ES");
        expect(wafBlockLocale("de-DE,de;q=0.9").locale).toBe("en-US");
        expect(wafBlockLocale(undefined).locale).toBe("en-US");
    });

    it("renders the whole page in Spanish", () => {
        const page = wafBlockPage({ reference: REFERENCE, cause: "tor", locale: "es-ES", retryNonce: "n" });
        expect(page).toContain('<html lang="es-ES" dir="ltr">');
        expect(page).toContain("El acceso a través de Tor está bloqueado");
        expect(page).toContain("ID de referencia");
        expect(page).toContain("Reintentar");
        expect(page).not.toContain("Sorry, you have been blocked");
    });

    it("has a sentence for every cause in every language it speaks", () => {
        for (const cause of WAF_BLOCK_CAUSES) {
            const en = wafBlockSentence({ cause }, "en-US");
            const es = wafBlockSentence({ cause }, "es-ES");
            expect(en.length).toBeGreaterThan(10);
            expect(es.length).toBeGreaterThan(10);
            expect(es).not.toBe(en);
        }
    });
});

describe("wafBlockJson", () => {
    it("answers with a stable code, the sentence, and the reference", () => {
        expect(wafBlockJson({ cause: "tor" }, { reference: REFERENCE, ip: "192.42.116.98", locale: "es-ES" })).toEqual({
            error: "blocked",
            reason: "tor",
            message: wafBlockSentence({ cause: "tor" }, "es-ES"),
            reference: REFERENCE,
            ip: "192.42.116.98"
        });
    });

    it("says when to retry only for a timed block", () => {
        const until = Date.parse("2026-11-22T10:00:00.000Z");
        expect(wafBlockJson({ cause: "rate_limited", until }, { reference: REFERENCE }).retryAfter).toBe(
            "2026-11-22T10:00:00.000Z"
        );
        expect(wafBlockJson({ cause: "anonymizer", until }, { reference: REFERENCE }).retryAfter).toBeUndefined();
    });
});

describe("the recorded cause", () => {
    it("is read back from a lookup, and an unknown one is dropped", () => {
        const base = { reference: REFERENCE, reason: "intel: tor", at: "2026-11-22T10:00:00.000Z" };
        expect(parseWafBlockRecord({ ...base, cause: "tor" })?.cause).toBe("tor");
        expect(parseWafBlockRecord({ ...base, cause: "nonsense" })?.cause).toBeUndefined();
        expect(parseWafBlockRecord(base)?.cause).toBeUndefined();
    });
});
