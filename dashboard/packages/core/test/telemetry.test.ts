/**
 * Reading what a crashing program says about itself.
 *
 * Two halves matter here and the second one is the product. The first is that a
 * real envelope from a real SDK is read at all - the payloads are quoted from
 * what the JavaScript and Python clients actually send, because a parser tested
 * only against its own idea of the format is a parser that works until somebody
 * points a client at it.
 *
 * The second is the grouping. A thousand copies of one crash has to be a number,
 * and two different crashes must not be filed as one - so what is asserted is
 * what changes the answer (a different exception, a different function) and, more
 * importantly, what must not (a line number that moved, an id inside the
 * message, a library frame further down the stack).
 */

import { describe, expect, it } from "vitest";
import {
    fingerprintOf,
    generalize,
    parseEnvelope,
    readEvent,
    readIngestKey,
    titleOf
} from "../src/telemetry.js";

const NOW = new Date("2026-09-04T12:00:00.000Z");

/** An event as the JavaScript SDK sends one. */
const crash = {
    event_id: "9f3a1c2e4b5d4f0a8c7b6e5d4c3b2a19",
    timestamp: NOW.getTime() / 1000,
    platform: "node",
    level: "error",
    release: "polaris@1.4.2",
    environment: "production",
    server_name: "lirio-0",
    transaction: "GET /api/deploy",
    request: { url: "https://example.test/api/deploy", method: "get" },
    user: { id: "u1", email: "someone@example.test" },
    tags: { runtime: "node@22" },
    exception: {
        values: [
            {
                type: "TypeError",
                value: "Cannot read properties of undefined (reading 'id')",
                stacktrace: {
                    frames: [
                        { filename: "node_modules/next/server.js", function: "run", lineno: 90, in_app: false },
                        { filename: "src/lib/deploy.ts", function: "deployApp", lineno: 42, colno: 7, in_app: true }
                    ]
                }
            }
        ]
    }
};

function envelopeOf(...items: { type: string; payload: unknown }[]): string {
    const lines = [JSON.stringify({ event_id: crash.event_id, sent_at: NOW.toISOString() })];
    for (const item of items) {
        const body = JSON.stringify(item.payload);
        lines.push(JSON.stringify({ type: item.type, length: body.length }));
        lines.push(body);
    }
    return `${lines.join("\n")}\n`;
}

describe("the envelope a client posts", () => {
    it("is read item by item", () => {
        const parsed = parseEnvelope(envelopeOf({ type: "event", payload: crash }));
        expect(parsed.items).toHaveLength(1);
        expect(parsed.items[0]!.type).toBe("event");
    });

    it("believes the stated length, so a payload with a newline in it survives", () => {
        // A message with a newline is normal - a stack trace pasted into one, a
        // multi-line log line - and splitting the body on newlines truncates it.
        const multiline = { ...crash, exception: undefined, message: "first line\nsecond line" };
        const parsed = parseEnvelope(envelopeOf({ type: "event", payload: multiline }));
        const event = readEvent(parsed.items[0]!.payload, NOW);
        expect(event?.value).toBe("first line\nsecond line");
    });

    it("keeps the readable items when one of them is broken", () => {
        // A client batches several kinds of thing into one request. Refusing all
        // of them because one is malformed loses the crash along with the noise.
        const body = [
            JSON.stringify({ sent_at: NOW.toISOString() }),
            JSON.stringify({ type: "client_report" }),
            "{not json",
            JSON.stringify({ type: "event", length: JSON.stringify(crash).length }),
            JSON.stringify(crash)
        ].join("\n");
        const parsed = parseEnvelope(body);
        expect(parsed.items.map((item) => item.type)).toEqual(["event"]);
    });

    it("survives a body that is only a header", () => {
        expect(parseEnvelope("{}").items).toEqual([]);
        expect(parseEnvelope("").items).toEqual([]);
    });
});

describe("which project a request names", () => {
    it("reads the key from the query, the header, or the envelope's own dsn", () => {
        expect(readIngestKey({ query: "abc123def456" })).toBe("abc123def456");
        expect(
            readIngestKey({
                header: "Sentry sentry_version=7, sentry_key=abc123def456, sentry_client=sentry.javascript/8"
            })
        ).toBe("abc123def456");
        expect(readIngestKey({ dsn: "https://abc123def456@polaris.example.test/api/telemetry/3" })).toBe(
            "abc123def456"
        );
    });

    it("refuses anything that is not shaped like a key", () => {
        // It goes into a lookup, so it is bounded and alphanumeric before it
        // goes anywhere near one.
        expect(readIngestKey({ query: "short" })).toBeNull();
        expect(readIngestKey({ query: "abc123'; drop table--" })).toBeNull();
        expect(readIngestKey({})).toBeNull();
    });
});

describe("reading an event", () => {
    const event = readEvent(crash, NOW)!;

    it("takes the exception, the place and the context", () => {
        expect(event.type).toBe("TypeError");
        expect(event.value).toBe("Cannot read properties of undefined (reading 'id')");
        expect(event.release).toBe("polaris@1.4.2");
        expect(event.environment).toBe("production");
        expect(event.method).toBe("GET");
    });

    it("names the application's own frame, not the library it surfaced in", () => {
        expect(event.culprit).toBe("deployApp (src/lib/deploy.ts:42)");
    });

    it("labels the person by what they were given a name by", () => {
        expect(event.user).toBe("someone@example.test");
    });

    it("reads a message-only event, which is a legitimate thing to report", () => {
        const logged = readEvent(
            { level: "warning", message: "Disk nearly full", timestamp: NOW.toISOString() },
            NOW
        );
        expect(logged?.type).toBe("");
        expect(logged?.value).toBe("Disk nearly full");
        expect(logged?.level).toBe("warning");
    });

    it("drops what is not a failure at all", () => {
        // A transaction, a session, a client report. The caller answers 200 and
        // stores nothing.
        expect(readEvent({ type: "transaction", spans: [] }, NOW)).toBeNull();
        expect(readEvent(null, NOW)).toBeNull();
    });

    it("does not believe a clock that is far from ours", () => {
        // An event stamped next year would sit at the top of every list forever,
        // and one stamped in 1970 would be pruned the moment it arrived.
        const future = readEvent({ ...crash, timestamp: "2031-01-01T00:00:00.000Z" }, NOW);
        expect(future?.at).toEqual(NOW);
        const near = readEvent({ ...crash, timestamp: "2026-09-04T11:00:00.000Z" }, NOW);
        expect(near?.at.toISOString()).toBe("2026-09-04T11:00:00.000Z");
    });

    it("reads a level it does not know as an error", () => {
        expect(readEvent({ ...crash, level: "critical" }, NOW)?.level).toBe("fatal");
        expect(readEvent({ ...crash, level: "spicy" }, NOW)?.level).toBe("error");
    });
});

describe("which issue an event belongs to", () => {
    const event = readEvent(crash, NOW)!;

    it("is the same crash after a line moves", () => {
        // Somebody adds an import above it. Grouping on the line number would
        // file the same bug again after every commit.
        const moved = readEvent(
            {
                ...crash,
                exception: {
                    values: [
                        {
                            ...crash.exception.values[0],
                            stacktrace: {
                                frames: [
                                    {
                                        filename: "node_modules/next/server.js",
                                        function: "run",
                                        lineno: 91,
                                        in_app: false
                                    },
                                    {
                                        filename: "src/lib/deploy.ts",
                                        function: "deployApp",
                                        lineno: 58,
                                        in_app: true
                                    }
                                ]
                            }
                        }
                    ]
                }
            },
            NOW
        )!;
        expect(moved.fingerprint).toBe(event.fingerprint);
    });

    it("is a different crash when the exception or the function is", () => {
        const other = readEvent(
            { ...crash, exception: { values: [{ ...crash.exception.values[0], type: "RangeError" }] } },
            NOW
        )!;
        expect(other.fingerprint).not.toBe(event.fingerprint);
    });

    it("is one issue for a message that only differs by an id", () => {
        const first = readEvent({ message: "user 91 not found", timestamp: NOW.toISOString() }, NOW)!;
        const second = readEvent({ message: "user 92 not found", timestamp: NOW.toISOString() }, NOW)!;
        expect(first.fingerprint).toBe(second.fingerprint);
        // But not for a message that says something else.
        const third = readEvent({ message: "team 91 not found", timestamp: NOW.toISOString() }, NOW)!;
        expect(third.fingerprint).not.toBe(first.fingerprint);
    });

    it("takes the reporter's own fingerprint over the guess", () => {
        const stated = fingerprintOf(event, ["payments", "timeout"]);
        expect(stated).not.toBe(event.fingerprint);
        expect(fingerprintOf({ ...event, type: "RangeError" }, ["payments", "timeout"])).toBe(stated);
    });

    it("adds to the guess rather than replacing it when asked to", () => {
        // `{{ default }}` is how Sentry spells "and also the usual".
        const both = fingerprintOf(event, ["{{ default }}", "tenant-a"]);
        expect(both).not.toBe(event.fingerprint);
        expect(both).not.toBe(fingerprintOf(event, ["tenant-a"]));
    });

    it("answers the same in every process", () => {
        // The whole thing rests on this: a fingerprint computed after a restart,
        // or in another release, has to match the row already stored.
        expect(event.fingerprint).toBe(readEvent(crash, NOW)!.fingerprint);
        expect(event.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    });

    it("takes the variable parts out of a message", () => {
        expect(generalize("order 4821 failed at 0xdeadbeef")).toBe("order <n> failed at <addr>");
    });
});

describe("what an issue is called", () => {
    it("is the class and the first line of what it said", () => {
        expect(titleOf({ type: "TypeError", value: "boom\nat line two" })).toBe("TypeError: boom");
        expect(titleOf({ type: "", value: "Disk nearly full" })).toBe("Disk nearly full");
        expect(titleOf({ type: "", value: "" })).toBe("Unknown error");
    });
});
