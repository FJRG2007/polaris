/**
 * Which tools a turn sends, find_tools, and read_current_view.
 */

import { describe, expect, it, vi } from "vitest";
import * as relevance from "@/lib/polar/tool-relevance";
import { pageContextSchema } from "@/lib/polar/shared";

const catalog: relevance.CatalogEntry[] = [
    { name: "polaris_search", description: "Search Polaris.", category: "polaris" },
    { name: "drive_list", description: "List files in a folder.", category: "files" },
    { name: "deploy_projects", description: "List deploy projects.", category: "development" },
    { name: "deploy_restart", description: "Restart a deployed service.", category: "development" },
    { name: "games_players", description: "Players online on a game server.", category: "games" },
    { name: "mail_list", description: "List mail in a mailbox.", category: "mail" }
];

const always = [relevance.READ_CURRENT_VIEW, relevance.FIND_TOOLS];

function run(set: Record<string, { execute?: unknown }>, name: string, input: unknown) {
    const execute = set[name]!.execute as (input: unknown, options: unknown) => Promise<unknown>;
    return execute(input, { toolCallId: "1", messages: [] });
}

describe("active tools", () => {
    it("sends only the discovery tools, whatever the screen", () => {
        expect(relevance.activeToolNames(catalog, always)).toEqual([
            relevance.READ_CURRENT_VIEW,
            relevance.FIND_TOOLS,
            "polaris_search"
        ]);
    });

    it("keeps what the conversation already reached for, in catalog order", () => {
        const names = relevance.activeToolNames(
            catalog,
            always,
            new Set(["mail_list", "games_players"])
        );
        expect(names).toEqual([...always, "polaris_search", "games_players", "mail_list"]);
    });

    it("never sends a name the catalog does not hold (switched off, not theirs)", () => {
        expect(relevance.activeToolNames(catalog, always, new Set(["vault_reveal"]))).toEqual([
            ...always,
            "polaris_search"
        ]);
    });

    it("bounds what one request carries, this turn's finds first", () => {
        const used = new Set(Array.from({ length: 100 }, (_, index) => `old_${index}`));
        const bounded = relevance.boundedLoad(new Set(["fresh"]), used);
        expect(bounded.size).toBe(relevance.LOADED_MAX);
        expect([...bounded][0]).toBe("fresh");
        // The newest of the older ones are kept.
        expect(bounded.has("old_99")).toBe(true);
        expect(bounded.has("old_0")).toBe(false);
    });
});

describe("what discovery loads", () => {
    it("loads by exact name, and says which names are not there", async () => {
        const output = (await run(relevance.findToolsTool(catalog), relevance.FIND_TOOLS, {
            names: ["mail_list", "vault_reveal"]
        })) as { tools: { name: string }[]; unavailable?: string[] };
        expect(output.tools.map((entry) => entry.name)).toEqual(["mail_list"]);
        expect(output.unavailable).toEqual(["vault_reveal"]);
        expect(relevance.loadedBy(relevance.FIND_TOOLS, output)).toEqual(["mail_list"]);
    });

    it("loads the tools polaris_search names for its matches", () => {
        const output = {
            ok: true,
            text: "...",
            data: {
                results: [
                    { next: [{ tool: "places_device_control" }, { tool: "places_devices" }] },
                    { next: [{ tool: "places_device_control" }] }
                ]
            }
        };
        expect(relevance.loadedBy("polaris_search", output)).toEqual([
            "places_device_control",
            "places_devices"
        ]);
    });

    it("loads a short polaris_tools answer for an intent, never the whole catalogue", () => {
        const rows = (count: number) => ({
            ok: true,
            text: "...",
            data: {
                matched: true,
                categories: [
                    {
                        category: "mail",
                        tools: Array.from({ length: count }, (_, index) => ({
                            name: `mail_${index}`,
                            needs: []
                        }))
                    }
                ]
            }
        });
        expect(relevance.loadedBy("polaris_tools", rows(2))).toEqual(["mail_0", "mail_1"]);
        expect(relevance.loadedBy("polaris_tools", rows(relevance.LOAD_MAX + 1))).toEqual([]);
    });

    it("loads nothing from any other tool's answer", () => {
        expect(relevance.loadedBy("mail_list", { tools: [{ name: "x" }] })).toEqual([]);
    });
});

describe("find_tools", () => {
    it("ranks by name, then description", () => {
        expect(
            relevance.rankTools(catalog, "restart deployment").map((entry) => entry.name)[0]
        ).toBe("deploy_restart");
        expect(
            relevance.rankTools(catalog, "minecraft players").map((entry) => entry.name)
        ).toEqual(["games_players"]);
        expect(relevance.rankTools(catalog, "?!")).toEqual([]);
    });

    it("answers names and one line, which the next step then gets", async () => {
        const output = await run(relevance.findToolsTool(catalog), relevance.FIND_TOOLS, {
            query: "players"
        });
        expect(output).toEqual({
            tools: [{ name: "games_players", description: "Players online on a game server." }]
        });
        const found = relevance.foundInSteps([
            { toolResults: [{ toolName: relevance.FIND_TOOLS, output }] }
        ]);
        expect([...found]).toEqual(["games_players"]);
        const used = relevance.usedInMessages([
            {
                parts: [
                    { type: "text" },
                    { type: `tool-${relevance.FIND_TOOLS}`, output },
                    { type: "tool-mail_list" }
                ]
            }
        ]);
        expect([...used].sort()).toEqual(
            [relevance.FIND_TOOLS, "games_players", "mail_list"].sort()
        );
    });
});

describe("find_tools with nothing matched", () => {
    const withPlaces: relevance.CatalogEntry[] = [
        ...catalog,
        { name: "places_devices", description: "The devices in this account's places.", category: "home" },
        { name: "places_device_control", description: "Switch something on or off.", category: "home" }
    ];

    it("lists the areas the person has tools in, so a query in another language is not a dead end", async () => {
        const output = (await run(relevance.findToolsTool(withPlaces), relevance.FIND_TOOLS, {
            query: "apaga los ventiladores del rack"
        })) as { tools: unknown[]; areas: { area: string; tools: string[] }[] };
        expect(output.tools).toEqual([]);
        expect(output.areas).toContainEqual({
            area: "home",
            count: 2,
            tools: ["places_devices", "places_device_control"]
        });
        expect(output.areas.map((entry) => entry.area)).toEqual([
            "polaris",
            "files",
            "development",
            "games",
            "mail",
            "home"
        ]);
    });

    it("still finds the device tools from the English words its description invites", () => {
        expect(
            relevance.rankTools(withPlaces, "turn off a device").map((entry) => entry.name)[0]
        ).toBe("places_devices");
    });

    it("reads words in any script", () => {
        expect(
            relevance.rankTools(
                [{ name: "x", description: "Récupère les fichiers.", category: "files" }],
                "récupère"
            )
        ).toHaveLength(1);
    });
});

describe("read_current_view", () => {
    const context = (record: { kind: string; id: string; name?: string }) =>
        pageContextSchema.parse({ route: "/x", app: "tasks", record });

    it("reads the record through its tool, capped and fenced", async () => {
        const call = vi.fn(async () => ({
            ok: true,
            text: "y".repeat(relevance.VIEW_TEXT_MAX + 50)
        }));
        const set = relevance.currentViewTool(context({ kind: "task", id: "T-1" }), call);
        const output = (await run(set, relevance.READ_CURRENT_VIEW, {})) as { text: string };
        expect(call).toHaveBeenCalledWith("tasks_get", { task: "T-1" });
        expect(output.text).toContain("<untrusted_page_data>");
        expect(output.text).toContain(`[cut at ${relevance.VIEW_TEXT_MAX} characters]`);
        expect(output.text.length).toBeLessThan(relevance.VIEW_TEXT_MAX + 400);
    });

    it("says so when the person cannot read it", async () => {
        const set = relevance.currentViewTool(
            context({ kind: "task", id: "T-1" }),
            async () => null
        );
        const output = (await run(set, relevance.READ_CURRENT_VIEW, {})) as { text: string };
        expect(output.text).toContain("cannot read this task");
    });

    it("never reads a vault item and points elsewhere for unknown kinds", async () => {
        const call = vi.fn();
        for (const kind of ["vault item", "server", "installed app", "deploy project"]) {
            const set = relevance.currentViewTool(context({ kind, id: "1" }), call as never);
            const output = (await run(set, relevance.READ_CURRENT_VIEW, {})) as { text: string };
            expect(output.text).toContain("find_tools");
        }
        expect(call).not.toHaveBeenCalled();
    });

    it("works with no screen shared", async () => {
        const output = (await run(
            relevance.currentViewTool(null, vi.fn()),
            relevance.READ_CURRENT_VIEW,
            {}
        )) as {
            text: string;
        };
        expect(output.text).toContain("not sharing");
    });
});
