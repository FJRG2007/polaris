/**
 * A check never opens a socket to the host's own loopback or link-local
 * addresses, whether they are typed as an address or reached through a name.
 */

import { describe, expect, it } from "vitest";
import type { CheckSpec } from "@polaris-app/status-pages/src/model/checks";
import { literalAllowed, probe } from "@polaris-app/status-pages/src/lib/probe";

const spec = (patch: Partial<CheckSpec>): CheckSpec => ({
    kind: "http",
    target: "",
    port: null,
    expectStatus: null,
    keyword: "",
    dnsType: null,
    dnsExpect: "",
    timeoutMs: 2000,
    ...patch
});

describe("literalAllowed", () => {
    it("refuses a typed loopback or metadata address and leaves names to the lookup", () => {
        expect(literalAllowed({ kind: "http", target: "http://127.0.0.1:8080/" })).toBe(false);
        expect(literalAllowed({ kind: "http", target: "http://169.254.169.254/latest" })).toBe(
            false
        );
        expect(literalAllowed({ kind: "tcp", target: "[::1]" })).toBe(false);
        expect(literalAllowed({ kind: "tcp", target: "192.168.1.20" })).toBe(true);
        expect(literalAllowed({ kind: "http", target: "https://example.com/" })).toBe(true);
    });
});

describe("probe", () => {
    it("reports a typed loopback address as blocked without dialing", async () => {
        expect(await probe(spec({ kind: "http", target: "http://127.0.0.1:9/" }))).toEqual({
            kind: "error",
            error: "blocked",
            latencyMs: null
        });
        expect(await probe(spec({ kind: "tcp", target: "127.0.0.1", port: 9 }))).toMatchObject({
            error: "blocked"
        });
    });

    it("refuses a name that resolves to loopback at connect time", async () => {
        expect(await probe(spec({ kind: "tcp", target: "localhost", port: 9 }))).toMatchObject({
            kind: "error",
            error: "blocked"
        });
        expect(await probe(spec({ kind: "http", target: "http://localhost:9/" }))).toMatchObject({
            kind: "error",
            error: "blocked"
        });
    });
});
