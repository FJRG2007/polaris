/**
 * Every answer the CLI reads names the CLI protocol versions this Polaris speaks,
 * and the CLI built from this same checkout is inside that range - so a release
 * never ships a server that turns its own CLI away. Matched with the path matcher
 * Next uses for `headers()`, so a pattern that stopped matching fails here.
 */

import { describe, expect, it } from "vitest";
import { pathToRegexp } from "next/dist/compiled/path-to-regexp";
import nextConfig, { CLI_PROTOCOL_RANGE } from "../../next.config.mjs";
import { CLI_PROTOCOL, compatibilityProblem } from "../../../../packages/cli/src/compat";

async function headersFor(path: string): Promise<Record<string, string>> {
    const rules = (await nextConfig.headers?.()) ?? [];
    const out: Record<string, string> = {};
    for (const rule of rules) {
        const matcher = pathToRegexp(rule.source, [], {
            strict: true,
            sensitive: false,
            delimiter: "/"
        });
        if (!matcher.test(path)) continue;
        for (const header of rule.headers) out[header.key] = header.value;
    }
    return out;
}

describe("the CLI protocol header", () => {
    it("is on every path the CLI calls", async () => {
        for (const path of [
            "/api/cli/authorize",
            "/api/cli/authorize/claim",
            "/api/cli/session",
            "/api/v1/me",
            "/api/v1/deploy/projects",
            "/api/v1/deploy/services"
        ]) {
            expect((await headersFor(path))["X-Polaris-Cli-Protocol"], path).toBe(
                CLI_PROTOCOL_RANGE
            );
        }
    });

    it("is not on the pages", async () => {
        expect((await headersFor("/account/downloads"))["X-Polaris-Cli-Protocol"]).toBeUndefined();
    });

    it("accepts the CLI built from this checkout", () => {
        expect(compatibilityProblem("https://polaris.example.com", CLI_PROTOCOL_RANGE)).toBeNull();
        const [oldest, newest] = CLI_PROTOCOL_RANGE.split("-").map(Number);
        expect(CLI_PROTOCOL).toBeGreaterThanOrEqual(oldest!);
        expect(CLI_PROTOCOL).toBeLessThanOrEqual(newest!);
    });
});
