/**
 * Export: Markdown follows the newest version of each turn, JSON keeps every
 * version, names are safe, the routes are owner-scoped and the zip leaves
 * temporary chats out.
 */

import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ID = "11111111-1111-4111-8111-111111111111";

const state = {
    anonymous: false,
    thread: null as unknown,
    listArgs: null as unknown,
    rows: [] as { id: string; title: string; updatedAt: Date }[]
};

vi.mock("@/lib/api-session", () => ({
    apiUser: async () =>
        state.anonymous
            ? NextResponse.json({ error: "unauthorized" }, { status: 401 })
            : { id: "u1", name: "Ana", viewingAs: null }
}));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@polaris/db", () => ({
    prisma: {
        polarThread: {
            findFirst: async (args: { where: { userId: string } }) =>
                args.where.userId === "u1" ? state.thread : null,
            findMany: async (args: unknown) => {
                state.listArgs = args;
                return state.rows;
            }
        }
    }
}));

const exporter = await import("@/lib/polar/export");
const single = await import("@/app/api/polar/threads/[id]/export/route");
const all = await import("@/app/api/polar/export/route");

const at = (n: number) => new Date(Date.UTC(2026, 9, 20, 10, n));
const stored = () => ({
    id: ID,
    title: "Trip to Lisbon",
    createdAt: at(0),
    updatedAt: at(5),
    // Newest first, as the query orders them.
    messages: [
        { id: "a2", parentId: "u2", role: "assistant", parts: [{ type: "text", text: "Second answer" }], metadata: null, createdAt: at(4) },
        { id: "u2", parentId: null, role: "user", parts: [{ type: "text", text: "Edited question" }], metadata: null, createdAt: at(3) },
        { id: "a1", parentId: "u1", role: "assistant", parts: [{ type: "text", text: "First answer" }, { type: "tool-search", input: { q: "x" } }], metadata: null, createdAt: at(2) },
        { id: "u1", parentId: null, role: "user", parts: [{ type: "text", text: "Question" }, { type: "file", filename: "plan.pdf", url: "/x" }], metadata: null, createdAt: at(1) }
    ]
});

beforeEach(() => {
    state.anonymous = false;
    state.thread = stored();
    state.rows = [];
});

describe("formats", () => {
    it("writes the newest path as Markdown, tools and files by name only", async () => {
        const thread = (await exporter.readExportThread("u1", ID))!;
        const markdown = exporter.threadMarkdown(thread, { user: "You", assistant: "Polar" });
        expect(markdown).toContain("# Trip to Lisbon");
        expect(markdown).toContain("Edited question");
        expect(markdown).toContain("Second answer");
        expect(markdown).not.toContain("First answer");
    });

    it("keeps every version in JSON", async () => {
        const thread = (await exporter.readExportThread("u1", ID))!;
        const parsed = JSON.parse(exporter.threadJson(thread));
        expect(parsed.messages.map((message: { id: string }) => message.id)).toEqual(["u1", "a1", "u2", "a2"]);
        expect(parsed.version).toBe(1);
    });

    it("follows a single chain and names files safely", () => {
        const path = exporter.newestPath([
            { id: "1", parentId: null, role: "user", parts: [], metadata: null, createdAt: "" },
            { id: "2", parentId: "1", role: "assistant", parts: [], metadata: null, createdAt: "" }
        ]);
        expect(path.map((message) => message.id)).toEqual(["1", "2"]);
        expect(exporter.exportFileName('Ünïcode "quotes"/../x', ID, "md")).toBe("unicode-quotes-x-11111111.md");
        expect(exporter.exportFileName("日本", ID, "json")).toBe("chat-11111111.json");
    });
});

describe("routes", () => {
    const params = { params: Promise.resolve({ id: ID }) };

    it("downloads one chat as Markdown or JSON", async () => {
        const markdown = await single.GET(new Request("http://x?format=markdown"), params);
        expect(markdown.headers.get("content-disposition")).toBe('attachment; filename="trip-to-lisbon-11111111.md"');
        expect(await markdown.text()).toContain("## export.you");
        const json = await single.GET(new Request("http://x?format=json"), params);
        expect(json.headers.get("content-type")).toContain("application/json");
    });

    it("refuses a bad format, an unknown chat and an anonymous caller", async () => {
        expect((await single.GET(new Request("http://x?format=pdf"), params)).status).toBe(400);
        state.thread = null;
        expect((await single.GET(new Request("http://x"), params)).status).toBe(404);
        state.anonymous = true;
        expect((await single.GET(new Request("http://x"), params)).status).toBe(401);
    });

    it("zips every saved chat and never a temporary one", async () => {
        state.rows = [{ id: ID, title: "Trip to Lisbon", updatedAt: at(5) }];
        const response = await all.GET();
        expect(response.headers.get("content-type")).toBe("application/zip");
        const bytes = new Uint8Array(await response.arrayBuffer());
        const text = new TextDecoder().decode(bytes);
        expect(text).toContain("markdown/trip-to-lisbon-11111111.md");
        expect(text).toContain("json/trip-to-lisbon-11111111.json");
        expect(state.listArgs).toMatchObject({ where: { userId: "u1", temporary: false } });
    });
});
