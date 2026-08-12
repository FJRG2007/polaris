/**
 * How a block is answered. The page itself is tested in @polaris/core; what matters here
 * is that a browser gets it, that anything else gets text instead of markup it will only
 * log, and that neither is cached.
 */

import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { sendBlocked } from "../src/block-page.js";

/** A ServerResponse stand-in that records what was written to it. */
function capture() {
    const written = { status: 0, headers: {} as Record<string, string>, body: "" };
    const res = {
        writeHead(status: number, headers: Record<string, string>) {
            written.status = status;
            written.headers = headers;
        },
        end(body: string) {
            written.body = body;
        }
    } as unknown as ServerResponse;
    return { res, written };
}

const HTML = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

describe("sendBlocked", () => {
    it("answers a browser with the page", () => {
        const { res, written } = capture();

        sendBlocked(res, { accept: HTML, host: "app.example.com", ip: "203.0.113.5" });

        expect(written.status).toBe(403);
        expect(written.headers["content-type"]).toContain("text/html");
        expect(written.body).toContain("you have been blocked");
        expect(written.body).toContain("app.example.com");
        expect(written.body).toContain("203.0.113.5");
    });

    it("answers anything else with text", () => {
        const { res, written } = capture();

        sendBlocked(res, { accept: "*/*", host: "app.example.com" });

        expect(written.status).toBe(403);
        expect(written.headers["content-type"]).toContain("text/plain");
        expect(written.body).toContain("Reference ID:");
        expect(written.body).not.toContain("<html");
    });

    it("is never cached", () => {
        const { res, written } = capture();

        sendBlocked(res, { accept: HTML });

        expect(written.headers["cache-control"]).toBe("no-store");
    });

    // The page tells whoever was turned away to quote its reference. Until this was
    // logged, the operator had nothing to look one up in - the reason the guard
    // computed was dropped where it was made.
    it("records the block, with the reference the visitor is shown and what decided", () => {
        const lines: string[] = [];
        const log = vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
        const { res, written } = capture();

        sendBlocked(res, {
            accept: HTML,
            host: "app.example.com",
            ip: "203.0.113.5",
            reason: "intel: ban (Missing-page flood: 9 in 5m)",
            uri: "/settings",
            method: "GET",
            userAgent: "Mozilla/5.0"
        });
        log.mockRestore();

        const entry = JSON.parse(lines[0] ?? "{}");
        expect(entry).toMatchObject({
            event: "waf.block",
            reason: "intel: ban (Missing-page flood: 9 in 5m)",
            ip: "203.0.113.5",
            host: "app.example.com",
            uri: "/settings",
            method: "GET"
        });
        expect(written.body).toContain(entry.reference);
        // What caught it stays in the log: telling a scanner which signature it tripped
        // is telling it what to change.
        expect(written.body).not.toContain("Missing-page flood");
    });

    it("carries a fresh reference on every block", () => {
        const references = new Set<string>();
        for (let index = 0; index < 5; index += 1) {
            const { res, written } = capture();
            sendBlocked(res, { accept: "*/*" });
            references.add(/Reference ID: (\S+)/.exec(written.body)?.[1] ?? "");
        }

        expect(references.size).toBe(5);
        for (const reference of references) {
            expect(reference).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        }
    });
});
