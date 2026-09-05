/**
 * What an event carries besides its stack.
 *
 * A crash report that is only a message and a stack is a report somebody has to
 * go and reproduce. The facts that stop them having to - which runtime, which
 * machine, how much memory was left, what the request was, which line of source
 * threw - are all in what every Sentry client already sends, and all of them
 * were being read off the wire and thrown away.
 *
 * The other half of this file is the rule about credentials. A request that
 * failed on a bad token reports the token with it, so the value has to survive
 * to be worth reading and must not sit in plain sight on a screen that gets
 * shared, screenshotted and pasted. It is marked here and covered there.
 */

import { describe, expect, it } from "vitest";
import { headerIsSecret, readEvent } from "../src/telemetry.js";

const NOW = new Date("2026-09-05T12:00:00Z");

/** A payload in the shape a Node SDK actually posts. */
function payload(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        event_id: "abc",
        level: "error",
        exception: {
            values: [
                {
                    type: "Error",
                    value: "socket hang up",
                    stacktrace: {
                        frames: [
                            {
                                filename: "/app/src/pay.ts",
                                function: "charge",
                                lineno: 12,
                                colno: 3,
                                in_app: true,
                                pre_context: ["const total = sum(items);", "try {"],
                                context_line: "  await gateway.charge(total);",
                                post_context: ["} catch (error) {", "  report(error);"]
                            }
                        ]
                    }
                }
            ]
        },
        ...extra
    };
}

describe("where the program was running", () => {
    it("keeps the runtime, the machine and the operating system", () => {
        const event = readEvent(
            payload({
                contexts: {
                    runtime: { name: "node", version: "v20.20.2", type: "runtime" },
                    os: { name: "Alpine Linux", version: "3.23.4" },
                    device: { arch: "x64", processor_count: 2, memory_size: 8323719168 }
                }
            }),
            NOW
        );

        const runtime = event?.contexts.find((group) => group.name === "runtime");
        expect(runtime?.fields).toContainEqual({ key: "version", value: "v20.20.2" });
        // "type" is the client repeating the group's own name, which is a row
        // that says nothing on every single group.
        expect(runtime?.fields.some((field) => field.key === "type")).toBe(false);

        const device = event?.contexts.find((group) => group.name === "device");
        expect(device?.fields).toContainEqual({ key: "processor_count", value: "2" });
    });

    it("reads them in a fixed order, so the screen does not rearrange itself", () => {
        const event = readEvent(
            payload({
                contexts: {
                    trace: { span_id: "fe24" },
                    device: { arch: "x64" },
                    runtime: { name: "node" },
                    os: { name: "Alpine Linux" }
                }
            }),
            NOW
        );
        expect(event?.contexts.map((group) => group.name)).toEqual([
            "runtime",
            "os",
            "device",
            "trace"
        ]);
    });

    it("says nothing rather than an empty heading", () => {
        const event = readEvent(payload({ contexts: { cloud_resource: {} } }), NOW);
        expect(event?.contexts).toEqual([]);
    });
});

describe("the line that threw", () => {
    it("comes with the lines around it", () => {
        const frame = readEvent(payload(), NOW)?.frames[0];
        expect(frame?.context).toBe("  await gateway.charge(total);");
        expect(frame?.pre).toEqual(["const total = sum(items);", "try {"]);
        expect(frame?.post).toEqual(["} catch (error) {", "  report(error);"]);
    });

    it("is fine with a client that sends none of it", () => {
        const bare = readEvent(
            {
                exception: {
                    values: [
                        {
                            type: "Error",
                            value: "nope",
                            stacktrace: { frames: [{ filename: "a.js", lineno: 1 }] }
                        }
                    ]
                }
            },
            NOW
        );
        expect(bare?.frames[0]?.pre).toEqual([]);
        expect(bare?.frames[0]?.post).toEqual([]);
    });
});

describe("the request that was in flight", () => {
    it("keeps the headers, and marks the ones nobody should read over a shoulder", () => {
        const event = readEvent(
            payload({
                request: {
                    url: "https://api.example.com/v1/verify",
                    method: "post",
                    headers: {
                        "content-type": "application/json",
                        authorization: "Bearer live-key-value",
                        "x-extension-signature": "1fec436d"
                    }
                }
            }),
            NOW
        );

        const headers = event?.request?.headers ?? [];
        expect(headers.find((field) => field.name === "content-type")?.secret).toBe(false);
        // Kept, not blanked: a credential is often the reason the request failed.
        const auth = headers.find((field) => field.name === "authorization");
        expect(auth?.value).toBe("Bearer live-key-value");
        expect(auth?.secret).toBe(true);
        expect(headers.find((field) => field.name === "x-extension-signature")?.secret).toBe(true);
        expect(event?.request?.method).toBe("POST");
    });

    it("splits a query string and marks a token in it", () => {
        const event = readEvent(
            payload({ request: { query_string: "page=2&api_key=value&q=hello+world" } }),
            NOW
        );
        const query = event?.request?.query ?? [];
        expect(query).toContainEqual({ name: "page", value: "2", secret: false });
        expect(query).toContainEqual({ name: "q", value: "hello world", secret: false });
        expect(query.find((field) => field.name === "api_key")?.secret).toBe(true);
    });

    it("covers a password inside the body", () => {
        const event = readEvent(
            payload({
                request: { data: { email: "a@b.com", password: "hunter2", nested: { token: "t" } } }
            }),
            NOW
        );
        expect(event?.request?.body).toContain("a@b.com");
        expect(event?.request?.body).not.toContain("hunter2");
        // Written out rather than dropped, so "it was sent and is hidden" reads
        // differently from "it was never sent".
        expect(event?.request?.body).toContain("[hidden]");
    });

    it("treats the cookie field as the credential it is", () => {
        const event = readEvent(payload({ request: { cookies: "session=abc" } }), NOW);
        expect(event?.request?.headers).toContainEqual({
            name: "cookie",
            value: "session=abc",
            secret: true
        });
    });

    it("is null for a report from something serving no request", () => {
        expect(readEvent(payload(), NOW)?.request).toBeNull();
    });
});

describe("which client reported, and from where", () => {
    it("keeps the sdk and the address", () => {
        const event = readEvent(
            payload({
                sdk: { name: "sentry.javascript.node", version: "9.22.0" },
                user: { ip_address: "35.157.170.0" }
            }),
            NOW
        );
        expect(event?.sdk).toEqual({ name: "sentry.javascript.node", version: "9.22.0" });
        expect(event?.ip).toBe("35.157.170.0");
    });
});

describe("a breadcrumb", () => {
    it("keeps what it was carrying", () => {
        const event = readEvent(
            payload({
                breadcrumbs: [
                    {
                        type: "http",
                        category: "http",
                        data: {
                            url: "http://backend:5000/v1/logs",
                            method: "POST",
                            status_code: 500
                        }
                    }
                ]
            }),
            NOW
        );
        // An http crumb with its data removed is the word "http".
        expect(event?.breadcrumbs[0]?.data).toContainEqual({ key: "status_code", value: "500" });
        expect(event?.breadcrumbs[0]?.data).toContainEqual({
            key: "url",
            value: "http://backend:5000/v1/logs"
        });
    });
});

describe("deciding what is a credential", () => {
    it("catches the ones that are, whatever they are called", () => {
        for (const name of [
            "Authorization",
            "proxy-authorization",
            "Cookie",
            "set-cookie",
            "x-api-key",
            "X-Auth-Token",
            "x-session-id",
            "client_secret",
            "signature",
            "password"
        ]) {
            expect(headerIsSecret(name)).toBe(true);
        }
    });

    it("leaves the ordinary ones alone", () => {
        for (const name of ["content-type", "accept", "user-agent", "x-forwarded-for", "host"]) {
            expect(headerIsSecret(name)).toBe(false);
        }
    });
});
