/**
 * The browser integrity check refuses traffic, so the expensive mistake is the false
 * positive: a CLI, a health check or a webhook blocked because it is not a browser
 * would get the whole control switched off, taking the true positives with it. Most
 * of what is protected here is therefore the traffic it must still let through.
 */

import { describe, expect, it } from "vitest";
import { browserIntegrityFailure } from "../src/waf-integrity.js";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** A real browser's request, which every other case here is a deviation from. */
const BROWSER = {
    userAgent: CHROME,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    acceptLanguage: "es-ES,es;q=0.9,en;q=0.8",
    acceptEncoding: "gzip, deflate, br"
};

describe("traffic it lets through", () => {
    it("passes a real browser", () => {
        expect(browserIntegrityFailure(BROWSER)).toBeNull();
    });

    it("passes an honest non-browser client that sends nothing else", () => {
        // The whole reason this is safe to arm on a scope that also serves an API.
        expect(browserIntegrityFailure({ userAgent: "curl/8.7.1" })).toBeNull();
        expect(browserIntegrityFailure({ userAgent: "Polaris-Healthcheck/1.0" })).toBeNull();
        expect(browserIntegrityFailure({ userAgent: "python-requests/2.32" })).toBeNull();
    });

    it("passes a browser missing only one of language or encoding", () => {
        expect(browserIntegrityFailure({ ...BROWSER, acceptLanguage: undefined })).toBeNull();
        expect(browserIntegrityFailure({ ...BROWSER, acceptEncoding: undefined })).toBeNull();
    });
});

describe("traffic it refuses", () => {
    it("refuses a request with no user agent", () => {
        expect(browserIntegrityFailure({})).toBe("no user agent");
        expect(browserIntegrityFailure({ userAgent: "" })).toBe("no user agent");
        expect(browserIntegrityFailure({ userAgent: "   " })).toBe("no user agent");
    });

    it("refuses a forged browser that sends no Accept header", () => {
        expect(browserIntegrityFailure({ userAgent: CHROME })).toBe(
            "browser user agent without an Accept header"
        );
    });

    it("refuses a forged browser with neither language nor encoding", () => {
        expect(browserIntegrityFailure({ userAgent: CHROME, accept: "*/*" })).toBe(
            "browser user agent without Accept-Language or Accept-Encoding"
        );
    });

    it("refuses a user agent carrying a control character", () => {
        const split = `Mozilla/5.0\r\nX-Injected: 1`;

        expect(browserIntegrityFailure({ userAgent: split })).toBe("malformed user agent");
    });

    it("refuses an oversized user agent", () => {
        expect(browserIntegrityFailure({ userAgent: "M".repeat(600) })).toBe("oversized user agent");
    });
});
