/**
 * What a turn's tool definitions cost, measured on core's real tools (approx.
 * tokens as characters / 4), at three points:
 *
 * - flat: every built-in tool, as the chat registered them at first;
 * - per screen: the core tools and the current app's, the step before;
 * - discovery: Polaris as an MCP connector - `polaris_search`,
 *   `polaris_tools`, `find_tools` and `read_current_view`, whatever the
 *   screen, and what discovery loads from the next step on.
 *
 * The system prompt and the screen note are measured too: the screen note
 * moved out of the system prompt so the prompt stays byte-identical.
 */

import { asSchema, type ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import { toolCategory } from "@/lib/mcp/protocol";
import { polarSystemPrompt } from "@/lib/polar/prompt";
import * as relevance from "@/lib/polar/tool-relevance";
import { fenceScreen, pageContextSchema } from "@/lib/polar/shared";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/deploy/api/surface", () => ({}));
// Reached through the deploy tools; nothing here opens a connection.
vi.mock("@/lib/docker-service", () => ({}));

const { MCP_TOOLS } = await import("@/lib/mcp/tools");

const tokens = (text: string) => Math.ceil(text.length / 4);

const catalog = MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    category: toolCategory(tool)
}));

/** Polar's own two tools, as built for a turn. */
const polarOwn: ToolSet = {
    ...relevance.findToolsTool(catalog),
    ...relevance.currentViewTool(null, async () => null)
};

/** One tool as a provider receives it: name, description, input schema. */
async function serialized(name: string): Promise<string> {
    const own = polarOwn[name] as { description?: string; inputSchema: never } | undefined;
    if (own) {
        return JSON.stringify({
            name,
            description: own.description,
            input_schema: await asSchema(own.inputSchema).jsonSchema
        });
    }
    const entry = MCP_TOOLS.find((tool) => tool.name === name)!;
    return JSON.stringify({
        name,
        description: entry.description,
        input_schema: await asSchema(entry.input as never).jsonSchema
    });
}

async function size(names: readonly string[]): Promise<number> {
    return tokens((await Promise.all(names.map(serialized))).join(""));
}

/** The per-screen rule as it stood before discovery, kept here to measure. */
const SCREEN_CATEGORIES: Record<string, readonly string[]> = {
    apps: ["development", "databases", "games"],
    tasks: ["productivity"],
    drive: ["files"]
};

describe("prompt size", () => {
    const screens = [
        { app: "apps", route: "/apps/deploy/p1", kind: "deploy project", id: "p1", name: "Shop" },
        { app: "tasks", route: "/tasks/t/T-12", kind: "task", id: "T-12", name: "Fix login" },
        { app: "drive", route: "/drive", kind: "drive folder", id: "/docs", name: "docs" }
    ];
    const always = [relevance.READ_CURRENT_VIEW, relevance.FIND_TOOLS];

    it("sends a fraction of the tool schemas through discovery, on every screen", async () => {
        const flat = await size(catalog.map((entry) => entry.name));
        const discovery = relevance.activeToolNames(catalog, always);
        const after = await size(discovery);
        const rows = [
            `flat: ~${flat} tokens (${catalog.length} tools)`,
            `discovery: ~${after} tokens (${discovery.length} tools: ${discovery.join(", ")})`
        ];
        for (const screen of screens) {
            const shown = new Set(["polaris", ...(SCREEN_CATEGORIES[screen.app] ?? [])]);
            const perScreen = [
                ...always,
                ...catalog.filter((entry) => shown.has(entry.category)).map((entry) => entry.name)
            ];
            const before = await size(perScreen);
            rows.push(`${screen.app}: per screen ~${before} tokens (${perScreen.length} tools)`);
            expect(after).toBeLessThan(before);
            const note = fenceScreen(
                pageContextSchema.parse({
                    route: screen.route,
                    app: screen.app,
                    record: { kind: screen.kind, id: screen.id, name: screen.name }
                })
            );
            expect(tokens(note)).toBeLessThan(80);
        }
        // The same tools on every screen: the provider's prefix cache holds.
        expect(discovery).toEqual(relevance.activeToolNames(catalog, always));
        expect(after * 5).toBeLessThan(flat);
        console.info(
            `polar tool schemas (core tools only, system prompt ~${tokens(polarSystemPrompt("Ana", null, "", true))}):\n${rows.join("\n")}`
        );
    });

    it("never sends more than the bound of loaded tools, however many exist", async () => {
        const many = Array.from({ length: 500 }, (_, index) => ({
            name: `mcp_big__tool_${index}`,
            description: `Tool ${index}.`,
            category: "Big server"
        }));
        const used = new Set(many.map((entry) => entry.name));
        const sent = relevance.activeToolNames(
            many,
            always,
            relevance.boundedLoad(new Set(), used)
        );
        expect(sent.length).toBeLessThanOrEqual(always.length + relevance.LOADED_MAX);
    });
});
