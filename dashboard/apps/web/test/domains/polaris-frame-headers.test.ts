/**
 * Polaris's own answer to clickjacking: every page refuses to be framed by another
 * site, except a published calendar's embed, which exists to be framed. Matched with
 * the same path matcher Next uses for `headers()`, so a pattern that silently stopped
 * matching (or started matching the embed) fails here rather than in a browser.
 */

import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config.mjs";
import { pathToRegexp } from "next/dist/compiled/path-to-regexp";

async function headersFor(path: string): Promise<Record<string, string>> {
    const rules = (await nextConfig.headers?.()) ?? [];
    const out: Record<string, string> = {};
    for (const rule of rules) {
        if (!pathToRegexp(rule.source, [], { strict: true, sensitive: false, delimiter: "/" }).test(path)) continue;
        for (const header of rule.headers) out[header.key] = header.value;
    }
    return out;
}

describe("Polaris's framing headers", () => {
    it("refuse other sites on every ordinary page", async () => {
        for (const path of ["/", "/home", "/mail", "/cal/book/abc", "/api/health", "/s/token"]) {
            expect(await headersFor(path), path).toEqual({
                "Content-Security-Policy": "frame-ancestors 'self'",
                "X-Frame-Options": "SAMEORIGIN"
            });
        }
    });

    it("leave a published calendar's embed frameable by any site", async () => {
        expect(await headersFor("/cal/embed/abc123")).toEqual({});
    });
});
