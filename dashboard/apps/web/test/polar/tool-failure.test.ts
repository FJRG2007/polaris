import { describe, expect, it } from "vitest";
import { InvalidToolInputError, NoSuchToolError, APICallError } from "ai";
import { matchForModel } from "@polaris/core";
import { ToolFailure, isToolFailure, toolFailureText, withTaggedToolErrors } from "@/lib/polar/tool-failure";

describe("a tool's failure is not the provider's", () => {
    it("knows the SDK's tool-call errors and a tagged throw", () => {
        const invalid = new InvalidToolInputError({ toolName: "places_devices", toolInput: '{"device":1}', cause: new Error("x") });
        expect(isToolFailure(invalid)).toBe(true);
        expect(toolFailureText(invalid)).toBe("places_devices was called with input it does not take.");
        const missing = new NoSuchToolError({ toolName: "places_devices" });
        expect(isToolFailure(missing)).toBe(true);
        expect(toolFailureText(missing)).toContain("places_devices");
        expect(isToolFailure(new ToolFailure("places_devices", new Error("/srv/secret path")))).toBe(true);
        expect(toolFailureText(new ToolFailure("t", new Error("/srv/secret path")))).not.toContain("/srv");
    });

    it("leaves a provider's refusal to the provider", () => {
        const refused = new APICallError({ message: "x", url: "https://example.test", requestBodyValues: {}, statusCode: 502 });
        expect(isToolFailure(refused)).toBe(false);
        expect(isToolFailure({ code: 502, message: "Provider returned error" })).toBe(false);
    });

    it("tags what a tool throws with its name", async () => {
        const tools = withTaggedToolErrors({
            boom: { execute: async () => { throw new Error("no"); } },
            quiet: { description: "no execute" }
        } as never) as Record<string, { execute?: () => Promise<unknown> }>;
        await expect(tools.boom!.execute!()).rejects.toBeInstanceOf(ToolFailure);
        expect(tools.quiet!.execute).toBeUndefined();
    });
});

describe("a device named loosely is still found", () => {
    const rows = [{ name: "lirio-0" }, { name: "Ventiladores del rack" }, { name: "Luz salón" }];
    const fields = [{ text: (row: { name: string }) => row.name, weight: 1 }];
    it.each(["rack Lirio 0", "Lirio 0", "LIRIO-0", "lírio 0"])("%s finds lirio-0 first", (query) => {
        const found = matchForModel(rows, query, fields, { one: "device", other: "devices" }, 100);
        expect(found.items.map((row) => row.name)).toContain("lirio-0");
    });
    it("names the closest when nothing matches instead of answering nothing", () => {
        const found = matchForModel(rows, "nevera", fields, { one: "device", other: "devices" }, 100);
        expect(found.items.length).toBeGreaterThan(0);
        expect(found.note).toBeTruthy();
    });
});
