/**
 * The tool catalogue, checked the way a client would read it.
 *
 * A tool whose schema cannot be produced is a tool a model sees with no arguments
 * and calls wrongly forever, and nothing at runtime would say so - the converter
 * throws inside a `tools/list` that a client then reports as a transport error.
 * So the whole catalogue is converted here, where it fails in front of whoever
 * added the tool.
 */

import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { toJsonSchema } from "@/lib/mcp/json-schema";

vi.mock("@polaris/db", () => ({ prisma: {} }));

const { MCP_TOOLS } = await import("@/lib/mcp/tools");
const { describeTool } = await import("@/lib/mcp/protocol");

describe("the catalogue", () => {
    it("describes every tool without the converter refusing one", () => {
        for (const tool of MCP_TOOLS) {
            const described = describeTool(tool) as { inputSchema: { type: string } };
            expect(described.inputSchema.type, tool.name).toBe("object");
        }
    });

    it("gives every tool a name a model can address and a description it can choose on", () => {
        for (const tool of MCP_TOOLS) {
            expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
            expect(tool.description.length, tool.name).toBeGreaterThan(20);
        }
    });

    it("has no two tools sharing a name", () => {
        const names = MCP_TOOLS.map((tool) => tool.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it("makes every tool that can change something ask for a scope", () => {
        for (const tool of MCP_TOOLS) {
            if (!tool.readOnly) expect(tool.scope, tool.name).not.toBeNull();
        }
    });
});

describe("toJsonSchema", () => {
    it("carries the bounds across, so a model is told the limit rather than discovering it", () => {
        expect(toJsonSchema(z.string().min(2).max(9))).toEqual({
            type: "string",
            minLength: 2,
            maxLength: 9
        });
        expect(toJsonSchema(z.number().int().min(1).max(100))).toEqual({
            type: "integer",
            minimum: 1,
            maximum: 100
        });
        expect(toJsonSchema(z.string().uuid())).toEqual({ type: "string", format: "uuid" });
    });

    it("treats a field with a default as one the caller need not send", () => {
        const schema = toJsonSchema(
            z.object({ a: z.string(), b: z.string().default("x"), c: z.string().optional() })
        );
        expect(schema.required).toEqual(["a"]);
        expect(schema.properties?.b?.default).toBe("x");
    });

    it("keeps the description, which is the only thing telling a model what a field means", () => {
        expect(toJsonSchema(z.string().describe("The branch."))).toMatchObject({
            description: "The branch."
        });
    });

    it("looks through a refinement to the shape underneath", () => {
        expect(toJsonSchema(z.object({ a: z.string() }).refine(() => true))).toMatchObject({
            type: "object"
        });
    });

    it("refuses loudly rather than handing over an empty schema", () => {
        expect(() => toJsonSchema(z.date())).toThrow(/ZodDate/);
    });
});
