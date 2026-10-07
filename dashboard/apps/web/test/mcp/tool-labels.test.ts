/**
 * Every MCP tool is named for a person, in every locale.
 *
 * A permission's info button lists what it lets an app do, one line per tool,
 * read from the tools themselves. A tool its catalogue does not name would
 * show there under its English title on a Spanish screen, so every catalogue
 * names exactly the tools it owns: core's in the dashboard's `mcp.tools`, each
 * app's in its own `mcp-tools.json`, with nothing left over from a tool that
 * is gone.
 */

import { describe, expect, it, vi } from "vitest";

// Loading the apps' tools reaches the auth module, which reads configuration as
// it is imported.
vi.stubEnv("POLARIS_DATABASE_URL", "postgresql://polaris:polaris@localhost:5432/polaris");
vi.stubEnv("POLARIS_AUTH_SECRET", "a-long-enough-string-for-the-schema");
vi.stubEnv("POLARIS_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));

vi.mock("@polaris/db", () => ({ prisma: {} }));

const { LOCALES } = await import("@polaris/core");
const { MCP_TOOLS } = await import("@/lib/mcp/tools");
const { toolScopes, defineMcpTool } = await import("@/lib/mcp/protocol");
const { abilitiesOf, coreToolLabels } = await import("@/lib/mcp/abilities");
const { calendarExtension } = await import("@polaris-app/calendar/src/lib/calendar-extension");
const { placesExtension } = await import("@polaris-app/places/src/lib/places-extension");
const { gameServersExtension } = await import("@polaris-app/game-servers/src/lib/games-extension");

/** The tools a person can be told about: the ones a scope opens. */
function scoped(tools: readonly { name: string; scope: unknown }[]): string[] {
    return tools
        .filter((tool) => toolScopes(tool as Parameters<typeof toolScopes>[0]).length > 0)
        .map((tool) => tool.name)
        .sort();
}

describe("MCP tool labels", () => {
    it.each(LOCALES)("names every core tool in %s, and nothing else", (locale) => {
        const labels = coreToolLabels(locale);
        expect(Object.keys(labels).sort()).toEqual(scoped(MCP_TOOLS));
        for (const label of Object.values(labels)) expect(label.trim()).not.toBe("");
    });

    const apps = [calendarExtension, placesExtension, gameServersExtension];
    for (const app of apps) {
        it.each(LOCALES)(`names every ${app.id} tool in %s, and nothing else`, async (locale) => {
            const tools = (await app.mcpTools?.()) ?? [];
            const labels = (await app.mcpToolLabels?.(locale)) ?? {};
            expect(tools.length).toBeGreaterThan(0);
            expect(Object.keys(labels).sort()).toEqual(scoped(tools));
            for (const label of Object.values(labels)) expect(label.trim()).not.toBe("");
        });
    }
});

describe("what a scope opens", () => {
    const tool = (name: string, scope: string | string[], readOnly: boolean) =>
        defineMcpTool({
            name,
            title: `${name} title`,
            description: name,
            input: (undefined as never),
            scope: scope as never,
            readOnly,
            async run() {
                return { text: "" };
            }
        });

    it("lists a tool under every scope that opens it, in the tools' order", () => {
        const found = abilitiesOf(
            [
                tool("a_look", "tasks.read", true),
                tool("a_change", "tasks.manage", false),
                tool("a_either", ["tasks.read", "tasks.manage"], true)
            ],
            (entry) => `label ${entry.name}`
        );
        expect(found["tasks.read"]).toEqual([
            { name: "a_look", label: "label a_look", readOnly: true },
            { name: "a_either", label: "label a_either", readOnly: true }
        ]);
        expect(found["tasks.manage"]?.map((entry) => entry.name)).toEqual(["a_change", "a_either"]);
    });

    it("leaves out the scopes nobody asked about", () => {
        const found = abilitiesOf(
            [tool("a_look", "tasks.read", true), tool("b_look", "notes.use", true)],
            (entry) => entry.name,
            new Set(["notes.use"] as const)
        );
        expect(Object.keys(found)).toEqual(["notes.use"]);
    });
});
