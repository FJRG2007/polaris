/**
 * Reading a stored event back.
 *
 * The detail column is schemaless on purpose - the shape of a crash report grows
 * every time a client starts sending something new - and the cost of that is
 * that a row is always older than the screen reading it. A release that started
 * keeping the source around a frame is a release after which every event stored
 * before it has frames with no `pre` and no `post`, and a screen that reads the
 * length of one of those is a screen that is blank for every fault reported
 * before the update. That is what this holds shut.
 */

import { describe, expect, it } from "vitest";
import { readStoredEvent } from "../src/telemetry.js";

/** What the column held before requests, snippets, contexts and crumb data were
 *  kept: the same names, with the lists that did not exist yet simply absent. */
const BEFORE = JSON.stringify({
    frames: [{ file: "app.js", function: "handle", line: 12, column: 4, inApp: true, context: null }],
    breadcrumbs: [{ at: null, type: "http", category: "fetch", message: "GET /a", level: "info" }],
    tags: { release: "1.0.0" },
    platform: "node"
});

describe("readStoredEvent", () => {
    it("gives an older row the lists the screen reads", () => {
        const event = readStoredEvent(BEFORE);
        expect(event.frames[0]!.pre).toEqual([]);
        expect(event.frames[0]!.post).toEqual([]);
        expect(event.breadcrumbs[0]!.data).toEqual([]);
        expect(event.contexts).toEqual([]);
        expect(event.request).toBeNull();
        expect(event.sdk).toBeNull();
    });

    it("keeps what the row does carry", () => {
        const event = readStoredEvent(BEFORE);
        expect(event.frames[0]!.file).toBe("app.js");
        expect(event.frames[0]!.line).toBe(12);
        expect(event.frames[0]!.inApp).toBe(true);
        expect(event.breadcrumbs[0]!.message).toBe("GET /a");
        expect(event.tags.release).toBe("1.0.0");
        expect(event.platform).toBe("node");
    });

    it("reads a row in the current shape whole", () => {
        const event = readStoredEvent(
            JSON.stringify({
                frames: [
                    {
                        file: "app.js",
                        function: "handle",
                        line: 12,
                        column: 4,
                        inApp: true,
                        context: "  throw err;",
                        pre: ["function handle() {"],
                        post: ["}"]
                    }
                ],
                breadcrumbs: [
                    {
                        at: "2026-09-05T12:00:00Z",
                        type: "http",
                        category: "fetch",
                        message: "GET /a",
                        level: "info",
                        data: [{ key: "status", value: "500" }]
                    }
                ],
                tags: { release: "1.0.0" },
                contexts: [{ name: "runtime", fields: [{ key: "name", value: "node" }] }],
                request: {
                    url: "https://example.test/a",
                    method: "GET",
                    query: [{ name: "page", value: "2", secret: false }],
                    headers: [{ name: "authorization", value: "Bearer live", secret: true }],
                    body: "{}"
                },
                sdk: { name: "sentry.javascript.node", version: "8.0.0" },
                ip: "203.0.113.9",
                platform: "node"
            })
        );
        expect(event.frames[0]!.pre).toEqual(["function handle() {"]);
        expect(event.frames[0]!.context).toBe("  throw err;");
        expect(event.breadcrumbs[0]!.data).toEqual([{ key: "status", value: "500" }]);
        expect(event.contexts[0]!.fields[0]).toEqual({ key: "name", value: "node" });
        expect(event.request?.query[0]!.name).toBe("page");
        expect(event.request?.body).toBe("{}");
        expect(event.sdk?.version).toBe("8.0.0");
        expect(event.ip).toBe("203.0.113.9");
    });

    // A row written before headers were marked still has a live token in it. The
    // flag is recomputed rather than defaulted to false, because the one thing
    // this screen may not do is draw a credential in the open on the strength of
    // which release the row happens to date from.
    it("covers a credential in a row that predates the marking", () => {
        const event = readStoredEvent(
            JSON.stringify({
                request: {
                    url: "https://example.test/a",
                    method: "GET",
                    headers: [
                        { name: "authorization", value: "Bearer live" },
                        { name: "accept", value: "application/json" }
                    ]
                }
            })
        );
        expect(event.request?.headers[0]!.secret).toBe(true);
        expect(event.request?.headers[1]!.secret).toBe(false);
    });

    it("answers with empty lists for a column that is not an event at all", () => {
        for (const stored of ["", "not json", "null", "[]", '"a string"', "{}"]) {
            const event = readStoredEvent(stored);
            expect(event.frames).toEqual([]);
            expect(event.breadcrumbs).toEqual([]);
            expect(event.contexts).toEqual([]);
            expect(event.tags).toEqual({});
            expect(event.request).toBeNull();
            expect(event.sdk).toBeNull();
            expect(event.ip).toBeNull();
            expect(event.platform).toBeNull();
        }
    });

    // Every list is one a program wrote while it was crashing, and a row that was
    // written by a client sending something unexpected is read rather than
    // trusted.
    it("survives a row whose lists hold the wrong things", () => {
        const event = readStoredEvent(
            JSON.stringify({
                frames: [null, 4, { file: 7, line: "12", pre: [null, 3], post: "no" }],
                breadcrumbs: "none",
                contexts: [{ name: "runtime", fields: "no" }, { fields: [{ key: "a", value: "b" }] }],
                tags: [["release", "1.0.0"]],
                request: { headers: {} },
                sdk: { version: "8.0.0" }
            })
        );
        expect(event.frames).toHaveLength(3);
        expect(event.frames[2]!.file).toBe("7");
        expect(event.frames[2]!.line).toBeNull();
        expect(event.frames[2]!.pre).toEqual(["", "3"]);
        expect(event.frames[2]!.post).toEqual([]);
        expect(event.breadcrumbs).toEqual([]);
        expect(event.contexts).toEqual([]);
        expect(event.tags.release).toBe("1.0.0");
        expect(event.request).toBeNull();
        expect(event.sdk).toBeNull();
    });
});
