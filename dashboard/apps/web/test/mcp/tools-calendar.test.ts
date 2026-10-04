/**
 * The calendar tool, called the way an MCP client calls it.
 *
 * Calendar is an installable app, reached only through the extension registry;
 * what is pinned here is that the tool asks the registry as the key's own
 * account, says so when no installed app keeps calendars, and refuses a key
 * without `calendar.use` before asking anything.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upcomingEventsFor: vi.fn() }));

vi.mock("@polaris/db", () => ({ prisma: {} }));
// The rest of the catalogue loads with these tools; its operations are not under test here.
vi.mock("@/lib/deploy/api/surface", () => ({}));
vi.mock("@/lib/app-extensions/registry", () => ({ upcomingEventsFor: mocks.upcomingEventsFor }));

const { CALENDAR_TOOLS } = await import("@/lib/mcp/tools/calendar");
const { MCP_TOOLS } = await import("@/lib/mcp/tools");
const { handleMcpMessage } = await import("@/lib/mcp/protocol");

const SERVER = { name: "polaris", version: "1", instructions: "" };

type ToolResult = { content: { text: string }[]; isError?: boolean; structuredContent?: any };

function call(args: Record<string, unknown>, scopes: string[] = ["calendar.use"]) {
    return handleMcpMessage(
        {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "calendar_upcoming", arguments: args }
        },
        MCP_TOOLS,
        { userId: "user-1", isAdmin: false, scopes: scopes as never, keyId: "key-1" },
        SERVER
    );
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("the calendar tool", () => {
    it("is in the catalogue, read-only, asking for calendar.use", () => {
        expect(MCP_TOOLS.map((tool) => tool.name)).toContain("calendar_upcoming");
        expect(CALENDAR_TOOLS.every((tool) => tool.readOnly && tool.scope === "calendar.use")).toBe(
            true
        );
    });

    it("refuses a key without calendar.use before asking the app", async () => {
        const result = (await call({}, ["notes.use"]))?.result as ToolResult;
        expect(result.isError).toBe(true);
        expect(mocks.upcomingEventsFor).not.toHaveBeenCalled();
    });

    it("rejects a page larger than the limit", async () => {
        expect((await call({ limit: 101 }))?.error?.code).toBe(-32602);
        expect(mocks.upcomingEventsFor).not.toHaveBeenCalled();
    });

    it("asks as the key's account and returns only what a model needs", async () => {
        mocks.upcomingEventsFor.mockResolvedValue([
            {
                id: "e1",
                title: "Standup",
                start: "2026-10-05T09:00:00.000Z",
                allDay: false,
                color: "#fff",
                href: "/calendar/e1"
            }
        ]);
        const result = (await call({ limit: 5 }))?.result as ToolResult;
        expect(mocks.upcomingEventsFor).toHaveBeenCalledWith("user-1", 5);
        expect(result.structuredContent).toEqual({
            events: [
                { id: "e1", title: "Standup", start: "2026-10-05T09:00:00.000Z", allDay: false }
            ]
        });
    });

    it("says so when no installed app keeps calendars", async () => {
        mocks.upcomingEventsFor.mockResolvedValue(null);
        const result = (await call({}))?.result as ToolResult;
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("not installed");
    });
});
