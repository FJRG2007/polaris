/**
 * The scope table against everything that names a scope.
 *
 * A scope a tool asks for and the table does not know is a tool nobody can be
 * granted; one with no label is a box on the consent screen that reads as its
 * key; one standing on no permission is a grant that never narrows when a
 * person loses their role. So every tool - core's and each installable app's,
 * read through the app's own `mcpTools` hook - is held to the table here, and
 * the table to both catalogs.
 */

import { join } from "node:path";
import { PERMISSIONS } from "@polaris/core";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import enMcp from "../../messages/en-US/mcp.json";
import esMcp from "../../messages/es-ES/mcp.json";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/deploy/api/surface", () => ({}));

const { MCP_TOOLS } = await import("@/lib/mcp/tools");
const { describeTool, toolScopes } = await import("@/lib/mcp/protocol");
const { requestedScopes, editableScopes } = await import("@/lib/mcp/oauth/scopes");
const table = await import("@/lib/mcp/scope-table");
const { calendarExtension } = await import("@polaris-app/calendar/src/lib/calendar-extension");
const { placesExtension } = await import("@polaris-app/places/src/lib/places-extension");
const { gameServersExtension } = await import("@polaris-app/game-servers/src/lib/games-extension");

const APP_TOOLS = {
    calendar: await calendarExtension.mcpTools!(),
    home: await placesExtension.mcpTools!(),
    games: await gameServersExtension.mcpTools!()
};
const EVERY_TOOL = [...MCP_TOOLS, ...Object.values(APP_TOOLS).flat()];

function label(catalog: { scopes: Record<string, string> }, scope: string): string | undefined {
    return catalog.scopes[scope.replace(".", "_")];
}

describe("the scope table", () => {
    it("never names a finer scope after a permission, and stands each on one", () => {
        for (const [scope, rule] of Object.entries(table.MCP_ONLY_SCOPES)) {
            expect(PERMISSIONS as readonly string[], scope).not.toContain(scope);
            expect(PERMISSIONS as readonly string[], scope).toContain(rule.requires);
            expect(scope.split(".")).toHaveLength(2);
            for (const implied of ("implies" in rule ? rule.implies : []) as string[])
                expect(table.isMcpOnlyScope(implied), `${scope} implies ${implied}`).toBe(true);
        }
    });

    it("labels every scope in both languages", () => {
        for (const scope of table.MCP_SCOPES) {
            expect(label(enMcp, scope), `en-US ${scope}`).toBeTruthy();
            expect(label(esMcp, scope), `es-ES ${scope}`).toBeTruthy();
        }
    });

    it("lists every scope once, each finer one after the permission it stands on", () => {
        expect(new Set(table.MCP_SCOPES).size).toBe(table.MCP_SCOPES.length);
        for (const scope of Object.keys(
            table.MCP_ONLY_SCOPES
        ) as (keyof typeof table.MCP_ONLY_SCOPES)[])
            expect(table.MCP_SCOPES.indexOf(scope)).toBeGreaterThan(
                table.MCP_SCOPES.indexOf(table.scopeRequires(scope))
            );
    });

    it("expands a managing scope with the reading one, and orders what it returns", () => {
        expect(table.expandScopes(["calendar.manage", "mail.send"])).toEqual([
            "mail.send",
            "calendar.read",
            "calendar.manage"
        ]);
        expect(table.expandScopes(["tasks.manage"])).toEqual(["tasks.read", "tasks.manage"]);
        expect(table.expandScopes(["databases.write"])).toEqual([
            "databases.read",
            "databases.write"
        ]);
        expect(table.scopeRequires("databases.write")).toBe("deploy.read");
        expect(table.scopeRequires("places.cameras")).toBe("home.read");
    });

    it("ignores, rather than trusts, a stored scope it does not know", () => {
        expect(
            table.readScopes(["tasks.read", "bogus.scope", "mail.read", "calendar.use"])
        ).toEqual(["mail.read", "calendar.use", "tasks.read"]);
    });

    it("waits for the person to tick what reaches outside Polaris", () => {
        expect(table.isSensitiveScope("mail.send")).toBe(true);
        expect(table.isSensitiveScope("places.control")).toBe(true);
        expect(table.isSensitiveScope("places.cameras")).toBe(true);
        expect(table.isSensitiveScope("databases.read")).toBe(true);
        expect(table.isSensitiveScope("databases.write")).toBe(true);
        expect(table.isSensitiveScope("mail.read")).toBe(false);
        expect(table.isSensitiveScope("tasks.manage")).toBe(false);
    });
});

/** Every locale the dashboard ships, read from disk so a new one is held to
 *  the same rule without anybody remembering this test. */
const MESSAGES = join(import.meta.dirname, "../../messages");
const LOCALES = readdirSync(MESSAGES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

function mcpCatalog(locale: string): { categories?: Record<string, string> } {
    return JSON.parse(readFileSync(join(MESSAGES, locale, "mcp.json"), "utf8"));
}

describe("scope categories", () => {
    it("files every scope, and every permission, under a category", () => {
        for (const scope of table.MCP_SCOPES)
            expect(table.MCP_CATEGORIES, scope).toContain(table.scopeCategory(scope));
        for (const permission of PERMISSIONS)
            expect(table.MCP_CATEGORIES, permission).toContain(table.scopeCategory(permission));
    });

    it("files a finer scope where the permission it stands on is filed", () => {
        expect(table.scopeCategory("places.control")).toBe(table.scopeCategory("home.control"));
        expect(table.scopeCategory("mail.send")).toBe("mail");
        expect(table.scopeCategory("gameservers.manage")).toBe("games");
    });

    it("labels every category in every locale", () => {
        expect(LOCALES.length).toBeGreaterThan(1);
        for (const locale of LOCALES) {
            const categories = mcpCatalog(locale).categories ?? {};
            for (const category of table.MCP_CATEGORIES)
                expect(categories[category], `${locale} ${category}`).toBeTruthy();
        }
    });

    it("puts the categories in order, scopes inside each in the table's order", () => {
        const grouped = table.groupByCategory([
            "tasks.read",
            "mail.send",
            "places.read",
            "mail.read"
        ]);
        expect(grouped).toEqual([
            { category: "home", scopes: ["places.read"] },
            { category: "mail", scopes: ["mail.read", "mail.send"] },
            { category: "productivity", scopes: ["tasks.read"] }
        ]);
    });
});

describe("every tool against the table", () => {
    it("asks only for scopes the table knows and both catalogs label", () => {
        for (const tool of EVERY_TOOL) {
            for (const scope of toolScopes(tool)) {
                expect(table.isMcpScope(scope), `${tool.name}: ${scope}`).toBe(true);
                expect(label(enMcp, scope), `${tool.name}: ${scope}`).toBeTruthy();
            }
        }
    });

    it("gives every app tool a scope, a schema a client can read, and a unique name", () => {
        const names = EVERY_TOOL.map((tool) => tool.name);
        expect(new Set(names).size).toBe(names.length);
        for (const tool of Object.values(APP_TOOLS).flat()) {
            expect(toolScopes(tool).length, tool.name).toBeGreaterThan(0);
            expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
            expect(tool.title, tool.name).toBeTruthy();
            expect(tool.description.length, tool.name).toBeGreaterThan(20);
            const described = describeTool(tool) as { inputSchema: { type: string } };
            expect(described.inputSchema.type, tool.name).toBe("object");
        }
    });

    it("files every tool under a category", () => {
        for (const tool of EVERY_TOOL)
            expect(table.MCP_CATEGORIES, tool.name).toContain(tool.category);
    });

    it("asks each app's own scopes of each app's tools", () => {
        const scopes = (tools: readonly { scope: unknown }[]) =>
            new Set(tools.flatMap((tool) => toolScopes(tool as never)));
        expect([...scopes(APP_TOOLS.calendar)].sort()).toEqual([
            "calendar.manage",
            "calendar.read",
            "calendar.use"
        ]);
        expect([...scopes(APP_TOOLS.home)].sort()).toEqual([
            "places.cameras",
            "places.control",
            "places.read",
            "places.routines"
        ]);
        expect([...scopes(APP_TOOLS.games)].sort()).toEqual([
            "gameservers.manage",
            "gameservers.moderate",
            "gameservers.read"
        ]);
        const mail = MCP_TOOLS.filter((tool) => tool.name.startsWith("mail_"));
        expect([...scopes(mail)].sort()).toEqual(["mail.read", "mail.send"]);
    });

    it("marks reading tools read-only and the rest as changing something", () => {
        const readOnly = EVERY_TOOL.filter((tool) => tool.readOnly).map((tool) => tool.name);
        for (const name of [
            "mail_list",
            "mail_read",
            "calendar_events",
            "places_devices",
            "places_routines",
            "games_servers",
            "games_server_status",
            "games_player_inventory"
        ])
            expect(readOnly).toContain(name);
        for (const name of [
            "mail_send",
            "calendar_create",
            "calendar_delete",
            "places_device_control",
            "places_routine_run",
            "games_server_power",
            "games_console"
        ])
            expect(readOnly).not.toContain(name);
        const destructive = (name: string) =>
            (describeTool(EVERY_TOOL.find((tool) => tool.name === name)!) as any).annotations
                .destructiveHint;
        expect(destructive("mail_send")).toBe(false);
        expect(destructive("calendar_create")).toBe(false);
        expect(destructive("calendar_delete")).toBe(true);
        expect(destructive("games_server_power")).toBe(true);
    });
});

describe("what an app may ask for, and be given", () => {
    const supported = ["tasks.read", "mail.read", "calendar.read"] as const;

    it("reads an app that still asks for the old calendar scope as asking for its successor", () => {
        expect(requestedScopes("calendar.use tasks.read", [...supported])).toEqual([
            "tasks.read",
            "calendar.read"
        ]);
        expect(requestedScopes("calendar.use", ["tasks.read"])).toEqual(["tasks.read"]);
    });

    it("lets an existing grant be given what is offered now, and keep its old scope", () => {
        expect(
            editableScopes(
                ["tasks.read", "calendar.use"],
                [...supported],
                ["tasks.read", "mail.use", "calendar.use"]
            )
        ).toEqual(["mail.read", "calendar.use", "calendar.read", "tasks.read"]);
        // Nothing the person does not hold.
        expect(editableScopes(["tasks.read"], [...supported], ["tasks.read"])).toEqual([
            "tasks.read"
        ]);
    });
});
