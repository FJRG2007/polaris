/**
 * A page that cannot be drawn reports what it failed with: one line in the
 * server's log, with addresses cut to their path and anything that reads like
 * a mail address, an id or a token masked, bounded in size and rate.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { clientErrorLine, redact } from "@/lib/client-error";
import { POST } from "@/app/api/client-error/route";

afterEach(() => vi.restoreAllMocks());

const post = (body: string) => POST(new Request("http://localhost/api/client-error", { method: "POST", body }));

describe("a page error report", () => {
    it("masks what could name somebody", () => {
        expect(redact("at https://polaris.example.test/game-servers/a?b=1 for someone@example.test 12345678")).toBe(
            "at /game-servers/a for <email> <n>"
        );
        expect(redact("token abcdefghijklmnopqrstuvwxyz0123456789")).toBe("token <token>");
    });

    it("is one line with the name, first line, path and frames", () => {
        const line = clientErrorLine({
            name: "TypeError",
            message: "Cannot read properties of null (reading 'tab')\nsecond line",
            path: "/game-servers/abc?x=1",
            stack: "TypeError: x\n    at Screen (https://polaris.example.test/_next/static/chunks/page.js:1:2)",
            boundary: "global"
        });
        expect(line).not.toContain("\n");
        expect(line).toContain("(global) on /game-servers/abc:");
        expect(line).toContain("TypeError: Cannot read properties of null (reading 'tab')");
        expect(line).toContain("at Screen (/_next/static/chunks/page.js:1:2)");
        expect(line).not.toContain("second line");
    });

    it("says so when the throw carried no message", () => {
        expect(clientErrorLine({})).toBe("polaris: page error (global) on ?: Error: (no message)");
    });

    it("logs a valid report and ignores the rest", async () => {
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect((await post(JSON.stringify({ name: "Error", message: "boom", path: "/home" }))).status).toBe(204);
        expect(log).toHaveBeenCalledTimes(1);
        await post("not json");
        await post(JSON.stringify({ boundary: "elsewhere" }));
        await post("x".repeat(17 * 1024));
        expect(log).toHaveBeenCalledTimes(1);
    });
});
