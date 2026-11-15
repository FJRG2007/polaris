/**
 * Tool parameters mirrored into `Mcp-Param-*` headers (SEP-2243, MCP
 * 2026-07-28 Streamable HTTP): which marks count, how a value is written, and
 * that no value can ever break out of its header. The encoding vectors are the
 * spec's own tables.
 */

import { describe, expect, it, vi } from "vitest";
import * as policy from "@/lib/polar/connectors/policy";
import {
    encodeParamValue,
    paramHeadersFor,
    paramText,
    scanParamHeaders,
    withParamHeaders
} from "@/lib/polar/connectors/param-headers";

/** The shape Stripe's server gives its tools. */
const STRIPE_LIKE = {
    type: "object",
    properties: {
        method: { type: "string" },
        livemode: { type: "boolean", "x-mcp-header": "Livemode" },
        stripe_context: { type: "string", "x-mcp-header": "Stripe-Context" }
    }
};

describe("which marks count", () => {
    it("finds top-level and nested marks reached through properties", () => {
        const scan = scanParamHeaders({
            type: "object",
            properties: {
                region: { type: "string", "x-mcp-header": "Region" },
                query: { type: "string" },
                options: {
                    type: "object",
                    properties: { tenant: { type: "integer", "x-mcp-header": "TenantId" } }
                }
            }
        });
        expect(scan).toEqual({
            valid: true,
            headers: [
                { path: ["region"], header: "Mcp-Param-Region" },
                { path: ["options", "tenant"], header: "Mcp-Param-TenantId" }
            ]
        });
    });

    it("finds none in a schema without marks", () => {
        expect(scanParamHeaders({ type: "object", properties: { a: { type: "string" } } })).toEqual({
            valid: true,
            headers: []
        });
    });

    it.each([
        ["an empty name", { a: { type: "string", "x-mcp-header": "" } }],
        ["a name with a space", { a: { type: "string", "x-mcp-header": "My Region" } }],
        ["a name with a colon", { a: { type: "string", "x-mcp-header": "Region:Primary" } }],
        ["a non-ASCII name", { a: { type: "string", "x-mcp-header": "Région" } }],
        ["a name with a tab", { a: { type: "string", "x-mcp-header": "Region\t1" } }],
        ["a name with CR LF", { a: { type: "string", "x-mcp-header": "A\r\nSet-Cookie: x" } }],
        ["a name that is not a string", { a: { type: "string", "x-mcp-header": 7 } }],
        ["a number property", { a: { type: "number", "x-mcp-header": "A" } }],
        ["an object property", { a: { type: "object", "x-mcp-header": "A" } }],
        ["an array property", { a: { type: "array", "x-mcp-header": "A" } }],
        ["a null property", { a: { type: "null", "x-mcp-header": "A" } }],
        ["a property with no type", { a: { "x-mcp-header": "A" } }],
        [
            "two names that differ only in case",
            {
                a: { type: "string", "x-mcp-header": "Region" },
                b: { type: "string", "x-mcp-header": "REGION" }
            }
        ]
    ])("rejects a tool with %s", (_label, properties) => {
        expect(scanParamHeaders({ type: "object", properties }).valid).toBe(false);
    });

    it.each([
        ["items", { list: { type: "array", items: { type: "string", "x-mcp-header": "A" } } }],
        ["anyOf", { a: { anyOf: [{ type: "string", "x-mcp-header": "A" }] } }],
        ["oneOf", { a: { oneOf: [{ type: "string", "x-mcp-header": "A" }] } }],
        ["allOf", { a: { allOf: [{ type: "string", "x-mcp-header": "A" }] } }],
        ["if/then", { a: { if: {}, then: { type: "string", "x-mcp-header": "A" } } }],
        [
            "additionalProperties",
            { a: { type: "object", additionalProperties: { type: "string", "x-mcp-header": "A" } } }
        ]
    ])("rejects a mark reached through %s", (_label, properties) => {
        expect(scanParamHeaders({ type: "object", properties }).valid).toBe(false);
    });

    it("rejects a mark behind a $ref, and one on the root", () => {
        expect(
            scanParamHeaders({
                type: "object",
                properties: { a: { $ref: "#/$defs/region" } },
                $defs: { region: { type: "string", "x-mcp-header": "Region" } }
            }).valid
        ).toBe(false);
        expect(scanParamHeaders({ type: "string", "x-mcp-header": "Root" }).valid).toBe(false);
    });

    it("allows a mark named like a standard header", () => {
        const scan = scanParamHeaders({
            type: "object",
            properties: { m: { type: "string", "x-mcp-header": "Method" } }
        });
        expect(scan).toEqual({ valid: true, headers: [{ path: ["m"], header: "Mcp-Param-Method" }] });
    });
});

describe("writing a value", () => {
    it("turns primitives into text, and refuses anything else", () => {
        expect(paramText("us-west1")).toBe("us-west1");
        expect(paramText(true)).toBe("true");
        expect(paramText(false)).toBe("false");
        expect(paramText(42)).toBe("42");
        expect(paramText(-7)).toBe("-7");
        expect(paramText(3.5)).toBeNull();
        expect(paramText(2 ** 53)).toBeNull();
        expect(paramText(Number.NaN)).toBeNull();
        expect(paramText({ a: 1 })).toBeNull();
        expect(paramText(["a"])).toBeNull();
        expect(paramText(null)).toBeNull();
    });

    it.each([
        ["us-west1", "us-west1"],
        ["us west 1", "us west 1"],
        ["", ""],
        ["Hello, 世界", "=?base64?SGVsbG8sIOS4lueVjA==?="],
        [" padded ", "=?base64?IHBhZGRlZCA=?="],
        [" us-west1", "=?base64?IHVzLXdlc3Qx?="],
        ["us-west1 ", "=?base64?dXMtd2VzdDEg?="],
        ["line1\nline2", "=?base64?bGluZTEKbGluZTI=?="],
        ["line1\r\nline2", "=?base64?bGluZTENCmxpbmUy?="],
        ["\tindented", "=?base64?CWluZGVudGVk?="],
        ["=?base64?literal?=", "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?="],
        ["日本語", "=?base64?5pel5pys6Kqe?="]
    ])("encodes %j as the spec does", (value, encoded) => {
        expect(encodeParamValue(value)).toBe(encoded);
    });

    it("never lets a control character or a non-ASCII byte through", () => {
        const hostile = [
            "acct_1\r\nSet-Cookie: session=stolen",
            "a\u0000b",
            "a\u007fb",
            "a\tb",
            "a b",
            "\u{1F600}"
        ];
        for (const value of hostile) {
            const encoded = encodeParamValue(value);
            expect(encoded).toMatch(/^=\?base64\?[A-Za-z0-9+/=]+\?=$/);
            expect(Buffer.from(encoded.slice(9, -2), "base64").toString("utf8")).toBe(value);
            // A header the platform accepts as a single field.
            expect(() => new Headers({ "Mcp-Param-X": encoded })).not.toThrow();
        }
    });
});

describe("the headers of one call", () => {
    it("carries marked arguments and leaves the rest out", () => {
        expect(
            paramHeadersFor(STRIPE_LIKE, {
                method: "GET /v1/customers",
                livemode: false,
                stripe_context: "acct_123"
            })
        ).toEqual({ "Mcp-Param-Livemode": "false", "Mcp-Param-Stripe-Context": "acct_123" });
    });

    it("sends no header for a null or absent value", () => {
        expect(paramHeadersFor(STRIPE_LIKE, { method: "x", livemode: null })).toEqual({});
    });

    it("reads a nested value at its exact path, and only an own property", () => {
        const schema = {
            type: "object",
            properties: {
                options: {
                    type: "object",
                    properties: { region: { type: "string", "x-mcp-header": "Region" } }
                }
            }
        };
        expect(paramHeadersFor(schema, { options: { region: "eu" } })).toEqual({
            "Mcp-Param-Region": "eu"
        });
        expect(paramHeadersFor(schema, { options: ["eu"] })).toEqual({});
        expect(paramHeadersFor(schema, { options: Object.create({ region: "eu" }) })).toEqual({});
    });

    it("sends none for a tool whose marks are invalid", () => {
        const schema = {
            type: "object",
            properties: { a: { type: "number", "x-mcp-header": "A" } }
        };
        expect(paramHeadersFor(schema, { a: 1 })).toEqual({});
    });
});

describe("adding them to the request", () => {
    const call = (name: string) =>
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name } });

    it("adds them to the tools/call POST of that tool only", async () => {
        const seen: Headers[] = [];
        const base = vi.fn(async (_url: string | URL, init?: RequestInit) => {
            seen.push(new Headers(init?.headers));
            return new Response(null, { status: 202 });
        });
        const fetch = withParamHeaders(base, "stripe_api_read", { "Mcp-Param-Livemode": "false" });
        const headers = new Headers({ authorization: "Bearer t" });
        await fetch("https://mcp.example.test", { method: "POST", headers, body: call("stripe_api_read") });
        await fetch("https://mcp.example.test", { method: "POST", headers, body: call("other") });
        await fetch("https://mcp.example.test", {
            method: "POST",
            headers,
            body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} })
        });
        await fetch("https://mcp.example.test", { method: "GET", headers });
        expect(seen.map((entry) => entry.get("mcp-param-livemode"))).toEqual([
            "false",
            null,
            null,
            null
        ]);
        expect(seen[0].get("authorization")).toBe("Bearer t");
    });

    it("hands back the same function when there is nothing to add", () => {
        const base = async () => new Response();
        expect(withParamHeaders(base, "t", {})).toBe(base);
    });
});

describe("the stored tool list", () => {
    it("leaves out a tool with invalid marks over Streamable HTTP, keeping the others", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const listed = [
            { name: "good", inputSchema: STRIPE_LIKE },
            {
                name: "bad",
                inputSchema: {
                    type: "object",
                    properties: { a: { type: "string", "x-mcp-header": "Bad Name" } }
                }
            }
        ];
        expect(policy.toCachedTools(listed).map((tool) => tool.name)).toEqual(["good"]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"bad"'));
        // The older HTTP+SSE transport may ignore the marks; the tool stays.
        expect(policy.toCachedTools(listed, "sse").map((tool) => tool.name)).toEqual([
            "good",
            "bad"
        ]);
        warn.mockRestore();
    });
});
