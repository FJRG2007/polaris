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
    it("sends the core and the current app's tools, in catalog order", () => {
        expect(relevance.activeToolNames(catalog, "drive", always)).toEqual([
            relevance.READ_CURRENT_VIEW,
            relevance.FIND_TOOLS,
            "polaris_search",
            "drive_list"
        ]);
        expect(relevance.activeToolNames(catalog, "unknown-app", always)).toEqual([
            ...always,
            "polaris_search"
        ]);
    });

    it("keeps what the conversation already reached for", () => {
        const names = relevance.activeToolNames(
            catalog,
            "drive",
            always,
            new Set(["games_players"])
        );
        expect(names).toContain("games_players");
        expect(names).not.toContain("mail_list");
    });

    it("is the same list for the same screen", () => {
        expect(relevance.activeToolNames(catalog, "mail", always)).toEqual(
            relevance.activeToolNames(catalog, "mail", always)
        );
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
