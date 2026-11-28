/**
 * MCP tools an app declares in its manifest: registered under the app's own
 * prefix and permission before its bundle loads, listed with the declared
 * input as their schema and the permission as their scope, run through the
 * bundle's handler, and answered only in the declared shape. An app the
 * catalogue delivers lists no tool its bundle builds without declaring it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    extensions: [] as unknown[],
    runnable: [] as string[]
}));
vi.mock("@/lib/app-bundles/store", () => ({ bundleRoot: () => "/nonexistent-polaris-test" }));
vi.mock("@/lib/app-extensions/installed", () => ({ installedExtensions: () => state.extensions }));
vi.mock("@/lib/apps/install-presence", () => ({ isAppInstalled: async () => true }));
vi.mock("@/lib/apps/runtime-catalog", async (original) => ({
    ...(await original<typeof import("@/lib/apps/runtime-catalog")>()),
    runnableIds: () => state.runnable
}));

import * as core from "@polaris/core";
import { McpRefusal } from "@/lib/mcp/protocol";
import { HOST_API } from "@polaris/app-host/version";
import { appMcpTools } from "@/lib/app-extensions/registry";
import { registerRuntimeApps } from "@/lib/apps/runtime-apps";
import { KNOWN_PERMISSIONS } from "@/lib/apps/runtime-catalog";
import { manifestMcpTools } from "@/lib/mcp/app-manifest-tools";
import { readAppCatalog, runtimeViews } from "@/lib/apps/runtime-catalog-schema";

const tool = (over: Record<string, unknown> = {}) => ({
    name: "bakery_list_loaves",
    title: { "en-US": "List loaves", "es-ES": "Ver barras" },
    description: { "en-US": "Lists the loaves in the oven. Read only." },
    permission: "bakery.use",
    readOnly: true,
    fields: [{ key: "oven", kind: "string", label: { "en-US": "Oven" } }],
    output: { count: "number" },
    items: { loafId: "id", grams: "number" },
    ...over
});

const bakery = {
    id: "bakery",
    version: "1.0.0",
    hostApi: HOST_API,
    name: { "en-US": "Bakery" },
    summary: { "en-US": "Run a bakery." },
    description: { "en-US": "Orders and ovens." },
    category: "Productivity",
    permissions: ["bakery.use"],
    permissionDefs: [{ key: "bakery.use", label: { "en-US": "Take orders" } }],
    mcpTools: [
        tool(),
        // Behind another app's permission, and outside its own prefix: both left out.
        tool({ name: "bakery_borrow", permission: "deploy.manage" }),
        tool({ name: "other_list_loaves" })
    ],
    bundle: { file: "bakery.zip", digest: `sha256:${"e".repeat(64)}`, size: 1024 },
    published: "2026-11-28T00:00:00.000Z"
};

const deliver = (apps: unknown[], locale = "en-US") =>
    registerRuntimeApps(
        runtimeViews(readAppCatalog({ schema: 1, kind: "apps", issued: "2026-11-28T00:00:00.000Z", apps }), KNOWN_PERMISSIONS, locale)
    );

const caller = { userId: "u1", isAdmin: false, scopes: ["bakery.use"] } as never;

afterEach(() => {
    deliver([]);
    state.extensions = [];
    state.runnable = [];
});

describe("a manifest's MCP tools", () => {
    it("registers only the app's own, behind its own permission, in the reader's language", () => {
        deliver([bakery], "es-ES");
        expect(core.appMcpToolDefinitions().map((one) => [one.name, one.title, one.permission])).toEqual([
            ["bakery_list_loaves", "Ver barras", "bakery.use"]
        ]);
    });

    it("lists each with the declared input as its schema and the permission as its scope", () => {
        deliver([bakery]);
        const [listed] = manifestMcpTools("bakery", async () => ({}));
        expect(listed).toMatchObject({ name: "bakery_list_loaves", scope: "bakery.use", readOnly: true, title: "List loaves" });
        expect(listed!.input.safeParse({ oven: "left" }).success).toBe(true);
        expect(listed!.input.safeParse({ oven: "left", extra: 1 }).success).toBe(false);
        expect(manifestMcpTools("bakery", undefined)).toEqual([]);
    });

    it("answers with what the handler said, only in the declared shape", async () => {
        deliver([bakery]);
        const handler = vi.fn(async () => ({ output: { count: 1, items: [{ loafId: "l-1", grams: 500 }] } }));
        const [listed] = manifestMcpTools("bakery", async () => ({ bakery_list_loaves: handler }));
        const result = await listed!.run({ oven: "left" } as never, caller);
        expect(handler).toHaveBeenCalledWith({ oven: "left" }, { userId: "u1" });
        expect(result.structured).toEqual({ count: 1, items: [{ loafId: "l-1", grams: 500 }] });

        handler.mockResolvedValueOnce({ output: { count: 1, items: [{ loafId: "l-1", secret: "x" }] } } as never);
        await expect(listed!.run({} as never, caller)).rejects.not.toBeInstanceOf(McpRefusal);
        handler.mockResolvedValueOnce({ refused: "The oven is off." } as never);
        await expect(listed!.run({} as never, caller)).rejects.toThrow(new McpRefusal("The oven is off."));
        const [without] = manifestMcpTools("bakery", async () => ({}));
        await expect(without!.run({} as never, caller)).rejects.toBeInstanceOf(McpRefusal);
    });

    it("lists a delivered app's declared tools and never one its bundle builds undeclared", async () => {
        deliver([bakery]);
        state.runnable = ["bakery"];
        const undeclared = { name: "bakery_sneaky", description: "x", input: core.appMcpToolInputSchema({ fields: [] }), scope: "bakery.use", readOnly: true, run: async () => ({ text: "" }) };
        state.extensions = [
            { id: "bakery", mcpTools: async () => [undeclared], mcpToolHandlers: async () => ({}) },
            // An app built into the image keeps building its tools in code.
            { id: "baked", mcpTools: async () => [{ ...undeclared, name: "baked_tool" }] }
        ];
        expect((await appMcpTools()).map((entry) => entry.tool.name)).toEqual(["bakery_list_loaves", "baked_tool"]);
    });
});
