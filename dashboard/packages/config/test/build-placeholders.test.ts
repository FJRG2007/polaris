/**
 * The stand-in environment `next build` runs under. Nothing is served with these, but
 * the libraries that read them are constructed while pages are collected, and a
 * secret they consider weak is reported once per prerendered page - which buried the
 * build log in warnings about a key that never leaves the builder.
 *
 * The thresholds pinned here are better-auth's own (32 characters, and its entropy
 * estimate of `length * log2(distinct characters)` at 120 bits). They are checked
 * against the placeholder rather than trusted, so shortening it back to a readable
 * string brings the warnings back here instead of in somebody's build.
 */

import { describe, expect, it } from "vitest";
import { loadEnv, resetEnvCache } from "../src/env.js";

/** better-auth's own estimate, from its context/secret-utils. */
function estimateEntropy(value: string): number {
    return Math.log2(Math.pow(new Set(value).size, value.length));
}

function buildEnv(): ReturnType<typeof loadEnv> {
    resetEnvCache();
    return loadEnv({ NEXT_PHASE: "phase-production-build" } as NodeJS.ProcessEnv);
}

describe("build placeholders", () => {
    it("lets the build load an environment nothing has been set in", () => {
        expect(buildEnv().POLARIS_APP_URL).toBe("http://localhost:3000");
        resetEnvCache();
    });

    it("stands in with secrets no library will warn about", () => {
        const env = buildEnv();
        for (const secret of [env.POLARIS_AUTH_SECRET, env.POLARIS_MASTER_KEY]) {
            expect(secret.length).toBeGreaterThanOrEqual(32);
            expect(estimateEntropy(secret)).toBeGreaterThanOrEqual(120);
        }
        resetEnvCache();
    });

    it("gives way to a secret the build was actually given", () => {
        const supplied = "supplied-build-secret-value";
        resetEnvCache();
        const env = loadEnv({
            NEXT_PHASE: "phase-production-build",
            POLARIS_AUTH_SECRET: supplied
        } as NodeJS.ProcessEnv);
        expect(env.POLARIS_AUTH_SECRET).toBe(supplied);
        resetEnvCache();
    });

    it("stays strict outside the build, where a real secret is required", () => {
        resetEnvCache();
        expect(() => loadEnv({} as NodeJS.ProcessEnv)).toThrow(/POLARIS_AUTH_SECRET/);
        resetEnvCache();
    });
});
