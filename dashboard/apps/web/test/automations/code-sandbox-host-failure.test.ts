/**
 * The Code step's sandbox when the server, not the code, fails.
 *
 * Pinned: an engine the thread cannot load answers with a fixed sentence, and
 * the cause - which names paths on this server - goes to the log only.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:module", async (original) => {
    const actual = await original<typeof import("node:module")>();
    const missing = "/srv/polaris/node_modules/quickjs-missing/index.js";
    return {
        ...actual,
        createRequire: () => Object.assign(() => undefined, { resolve: () => missing })
    };
});

afterEach(() => vi.restoreAllMocks());

describe("Code step sandbox: host failures", () => {
    it("does not show the server's own error", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const { runCode } = await import("@/lib/automations/code-sandbox");
        const result = await runCode("return items;", []);
        expect(result).toMatchObject({ ok: false, kind: "runtime" });
        if (!result.ok) {
            expect(result.message).toBe("The Code step failed on this server.");
            expect(result.message).not.toContain("quickjs-missing");
        }
        expect(String(logged.mock.calls.flat().join(" "))).toContain("quickjs-missing");
    });
});
