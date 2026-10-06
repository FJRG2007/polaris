/**
 * `polaris_search` and `polaris_tools`, and the runner behind the first.
 *
 * What is pinned: a provider is asked only when the caller holds its scope;
 * they run together, and one that throws or hangs is left out and named rather
 * than failing the search; a next step the caller could not take is not
 * offered; and the catalogue keeps an app's provider out when it breaks the
 * rules a tool is held to. `polaris_tools` groups every tool by category, says
 * which the caller cannot call, and narrows to an intent in any language.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    appMcpTools: vi.fn(),
    appMcpSearchProviders: vi.fn(),
    extensions: [] as unknown[]
}));

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/deploy/api/surface", () => ({}));
// A tool's call reaches the registry the setup file loaded, which no mock here
// replaces; it is fed one level down, through what it reads.
vi.mock("@/lib/app-extensions/installed", () => ({
    installedExtensions: () => mocks.extensions
}));
vi.mock("@/lib/apps/install-presence", () => ({ isAppInstalled: async () => true }));
vi.mock("@/lib/app-extensions/registry", () => ({
    appMcpTools: mocks.appMcpTools,
    appMcpSearchProviders: mocks.appMcpSearchProviders
}));

const { searchEverywhere, refLine } = await import("@/lib/mcp/search");
const { handleMcpMessage } = await import("@/lib/mcp/protocol");
const { mcpSearchProviders } = await import("@/lib/mcp/catalog");
const { MCP_TOOLS, MCP_SEARCH_PROVIDERS } = await import("@/lib/mcp/tools");

import type { McpCaller } from "@/lib/mcp/protocol";
import type { McpSearchProvider } from "@/lib/mcp/search";

const SERVER = { name: "polaris", version: "1", instructions: "" };
type ToolResult = { content: { text: string }[]; isError?: boolean; structuredContent?: any };

const caller = (scopes: string[]): McpCaller => ({
    userId: "user-1",
    isAdmin: false,
    scopes: scopes as never,
    grantId: "grant-1"
});

function provider(
    id: string,
    scope: string,
    hits: () => Promise<{ id: string; name: string; kind: string; next?: any[] }[]>
): McpSearchProvider {
    return {
        id,
        app: id.split(".")[0]!,
        category: "home",
        scope: scope as never,
        async search() {
            return (await hits()).map((hit) => ({ next: [], ...hit }));
        }
    };
}

const TOOL = (name: string, scope: string) =>
    ({ name, scope, readOnly: true, description: "x", input: {} }) as never;

beforeEach(() => {
    vi.clearAllMocks();
    mocks.appMcpTools.mockResolvedValue([]);
    mocks.appMcpSearchProviders.mockResolvedValue([]);
    mocks.extensions = [];
});

describe("searchEverywhere", () => {
    it("asks only the providers whose scope the caller holds", async () => {
        const read = vi.fn(async () => [{ id: "d1", name: "Puerta", kind: "device" }]);
        const mail = vi.fn(async () => [{ id: "m1", name: "Puerta nueva", kind: "mail" }]);
        const answer = await searchEverywhere({
            query: "puerta",
            caller: caller(["places.read"]),
            providers: [
                provider("places.things", "places.read", read),
                provider("mail.x", "mail.read", mail)
            ],
            tools: [],
            limit: 10
        });
        expect(read).toHaveBeenCalled();
        expect(mail).not.toHaveBeenCalled();
        expect(answer.refs.map((ref) => ref.id)).toEqual(["d1"]);
    });

    it("leaves out, and names, a provider that throws or does not answer in time", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const answer = await searchEverywhere({
            query: "puerta",
            caller: caller(["places.read", "mail.read", "tasks.read"]),
            providers: [
                provider("places.things", "places.read", async () => [
                    { id: "d1", name: "Puerta", kind: "device" }
                ]),
                provider("mail.x", "mail.read", async () => {
                    throw new Error("connection refused at 10.0.0.9");
                }),
                provider("tasks.x", "tasks.read", () => new Promise(() => undefined))
            ],
            tools: [],
            limit: 10,
            timeoutMs: 50
        });
        expect(answer.refs.map((ref) => ref.id)).toEqual(["d1"]);
        expect(answer.missing.sort()).toEqual(["mail", "tasks"]);
        expect(error).toHaveBeenCalledWith("mcp: search provider mail.x failed", expect.any(Error));
        expect(warn).toHaveBeenCalledWith("mcp: search provider tasks.x did not answer in time");
        error.mockRestore();
        warn.mockRestore();
    });

    it("offers only the next steps the caller may take", async () => {
        const answer = await searchEverywhere({
            query: "puerta",
            caller: caller(["places.read"]),
            providers: [
                provider("places.things", "places.read", async () => [
                    {
                        id: "d1",
                        name: "Puerta",
                        kind: "device",
                        next: [
                            { tool: "places_device_control", args: { deviceId: "d1" } },
                            { tool: "places_devices", args: { deviceId: "d1" } },
                            { tool: "no_such_tool" }
                        ]
                    }
                ])
            ],
            tools: [
                TOOL("places_devices", "places.read"),
                TOOL("places_device_control", "places.control")
            ],
            limit: 10
        });
        expect(answer.refs[0]?.next).toEqual([
            { tool: "places_devices", args: { deviceId: "d1" } }
        ]);
        expect(refLine(answer.refs[0]!)).toBe(
            '[places/device] Puerta (id d1) -> places_devices {"deviceId":"d1"}'
        );
    });

    it("never answers with nothing while something is reachable", async () => {
        const answer = await searchEverywhere({
            query: "zebra",
            caller: caller(["places.read"]),
            providers: [
                provider("places.things", "places.read", async () => [
                    { id: "d1", name: "Puerta", kind: "device" },
                    { id: "d2", name: "Lámpara", kind: "device" }
                ])
            ],
            tools: [],
            limit: 10
        });
        expect(answer.matched).toBe(false);
        expect(answer.refs).toHaveLength(2);
        expect(answer.note).toBe(
            'No match for "zebra"; these are all 2 things this connection can reach.'
        );
    });

    it("holds each provider to its cap", async () => {
        const many = Array.from({ length: 500 }, (_, index) => ({
            id: `d${index}`,
            name: `Puerta ${index}`,
            kind: "device"
        }));
        const answer = await searchEverywhere({
            query: "puerta",
            caller: caller(["places.read"]),
            providers: [provider("places.things", "places.read", async () => many)],
            tools: [],
            limit: 50
        });
        expect(answer.refs).toHaveLength(50);
    });
});

describe("the catalogue's providers", () => {
    it("offers core's, each with a scope from the table", async () => {
        const { isMcpScope } = await import("@/lib/mcp/scope-table");
        const { toolScopes } = await import("@/lib/mcp/protocol");
        const ids = MCP_SEARCH_PROVIDERS.map((entry) => entry.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const entry of MCP_SEARCH_PROVIDERS) {
            expect(toolScopes(entry).length, entry.id).toBeGreaterThan(0);
            expect(toolScopes(entry).every(isMcpScope), entry.id).toBe(true);
        }
        expect(ids).toEqual(
            expect.arrayContaining([
                "tasks.tasks",
                "notes.notes",
                "chat.conversations",
                "drive.files",
                "mail.conversations",
                "deploy.services"
            ])
        );
    });

    it("leaves out an app's provider with no scope or a taken id", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const good = provider("home.things", "places.read", async () => []);
        mocks.appMcpSearchProviders.mockResolvedValue([
            { app: "home", provider: good },
            { app: "home", provider: { ...good, scope: [] } },
            { app: "other", provider: { ...good, id: "tasks.tasks" } },
            { app: "other", provider: { ...good, id: "other.x", scope: "bogus.scope" } }
        ]);
        const providers = await mcpSearchProviders();
        expect(providers.filter((entry) => entry.id === "home.things")).toHaveLength(1);
        expect(providers.filter((entry) => entry.id === "tasks.tasks")).toHaveLength(1);
        expect(providers.some((entry) => entry.id === "other.x")).toBe(false);
        expect(error).toHaveBeenCalledTimes(3);
        error.mockRestore();
    });
});

async function call(name: string, args: Record<string, unknown>, scopes: string[]) {
    const reply = await handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        MCP_TOOLS,
        caller(scopes),
        SERVER
    );
    return reply?.result as ToolResult;
}

describe("polaris_search", () => {
    it("is offered to every connection and answers from the apps' providers", async () => {
        mocks.extensions = [
            {
                id: "places",
                mcpSearch: async () => [
                    provider("places.things", "places.read", async () => [
                        {
                            id: "d1",
                            name: "Puerta principal",
                            kind: "device",
                            next: [{ tool: "places_device_control", args: { deviceId: "d1" } }]
                        }
                    ])
                ]
            }
        ];
        const result = await call("polaris_search", { query: "door" }, ["places.read"]);
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent.results[0]).toEqual({
            app: "places",
            kind: "device",
            id: "d1",
            name: "Puerta principal",
            where: null,
            next: []
        });
        expect(result.content[0]?.text).toContain("Puerta principal");
    });

    it("says so when nothing at all is reachable", async () => {
        const result = await call("polaris_search", { query: "door" }, []);
        expect(result.content[0]?.text).toBe('Nothing this connection can reach matches "door".');
        expect(result.structuredContent.results).toEqual([]);
    });

    it("refuses an empty query as a bad argument", async () => {
        const reply = await handleMcpMessage(
            {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "polaris_search", arguments: { query: " " } }
            },
            MCP_TOOLS,
            caller([]),
            SERVER
        );
        expect(reply?.error?.code).toBe(-32602);
    });
});

describe("polaris_tools", () => {
    it("lists every tool grouped by category, saying which need a scope the caller lacks", async () => {
        const result = await call("polaris_tools", {}, ["tasks.read"]);
        const categories = result.structuredContent.categories as {
            category: string;
            tools: { name: string; needs: string[] }[];
        }[];
        const names = categories.flatMap((group) => group.tools.map((tool) => tool.name));
        expect(names.sort()).toEqual(MCP_TOOLS.map((tool) => tool.name).sort());
        expect(categories[0]?.category).toBe("polaris");
        const list = categories
            .flatMap((group) => group.tools)
            .find((tool) => tool.name === "tasks_list");
        expect(list?.needs).toEqual([]);
        const send = categories
            .flatMap((group) => group.tools)
            .find((tool) => tool.name === "mail_send");
        expect(send?.needs).toEqual(["mail.send"]);
        expect(result.content[0]?.text).toContain("mail_send - ");
        expect(result.content[0]?.text).toContain("(needs the mail.send scope)");
    });

    it("narrows to an intent, in another language", async () => {
        const result = await call("polaris_tools", { intent: "enviar correo" }, []);
        const first = result.structuredContent.categories[0];
        expect(first.category).toBe("mail");
        expect(first.tools[0].name).toBe("mail_send");
    });

    it("narrows to a category", async () => {
        const result = await call("polaris_tools", { category: "files" }, []);
        expect(result.structuredContent.categories.map((group: any) => group.category)).toEqual([
            "files"
        ]);
    });
});
