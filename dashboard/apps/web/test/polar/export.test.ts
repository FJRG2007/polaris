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
    listCalls: [] as unknown[],
    rows: [] as { id: string; title: string; updatedAt: Date }[],
    pages: null as null | { id: string; title: string; updatedAt: Date }[][]
};

vi.mock("@/lib/api-session", () => ({
    apiUser: async () =>
        state.anonymous
            ? NextResponse.json({ error: "unauthorized" }, { status: 401 })
            : { id: "u1", name: "Ana", viewingAs: null }
}));
vi.mock("@/lib/polar/access", async () =>
    (await import("./fixtures/open-polar-access")).openPolarAccess()
);
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/i18n/request", () => ({
    getTranslations: async () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}(${Object.values(values).join(",")})` : key
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        polarThread: {
            findFirst: async (args: { where: { userId: string } }) =>
                args.where.userId === "u1" ? state.thread : null,
            findMany: async (args: unknown) => {
                state.listArgs = args;
                state.listCalls.push(args);
                return state.pages ? (state.pages.shift() ?? []) : state.rows;
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
        {
            id: "a2",
            parentId: "u2",
            role: "assistant",
            parts: [{ type: "text", text: "Second answer" }],
            metadata: null,
            createdAt: at(4)
        },
        {
            id: "u2",
            parentId: null,
            role: "user",
            parts: [{ type: "text", text: "Edited question" }],
            metadata: null,
            createdAt: at(3)
        },
        {
            id: "a1",
            parentId: "u1",
            role: "assistant",
            parts: [
                { type: "text", text: "First answer" },
                { type: "tool-search", input: { q: "x" } }
            ],
            metadata: null,
            createdAt: at(2)
        },
        {
            id: "u1",
            parentId: null,
            role: "user",
            parts: [
                { type: "text", text: "Question" },
                { type: "file", filename: "plan.pdf", url: "/x" }
            ],
            metadata: null,
            createdAt: at(1)
        }
    ]
});

beforeEach(() => {
    state.anonymous = false;
    state.thread = stored();
    state.rows = [];
    state.pages = null;
    state.listCalls = [];
});

const NAMES = {
    user: "Tú",
    assistant: "Polar",
    untitled: "Conversación",
    attachment: "adjunto",
    file: (name: string) => `Archivo: ${name}`,
    used: (name: string) => `Usó ${name}`,
    truncated: "Recortado",
    compacted: (auto: boolean) => (auto ? "Compactada sola" : "Compactada")
};

describe("formats", () => {
    it("writes a compaction marker as a divider, never as an answer", () => {
        const at = new Date(0).toISOString();
        const markdown = exporter.threadMarkdown(
            {
                id: ID,
                title: "Long chat",
                createdAt: at,
                updatedAt: at,
                truncated: false,
                messages: [
                    {
                        id: "u",
                        parentId: null,
                        role: "user",
                        parts: [{ type: "text", text: "Hi" }],
                        metadata: null,
                        createdAt: at
                    },
                    {
                        id: "c",
                        parentId: "u",
                        role: "assistant",
                        parts: [{ type: "text", text: "Summary of everything" }],
                        metadata: { compaction: { auto: true, keep: 0, at } },
                        createdAt: at
                    },
                    {
                        id: "a",
                        parentId: "c",
                        role: "assistant",
                        parts: [{ type: "text", text: "Next answer" }],
                        metadata: null,
                        createdAt: at
                    }
                ]
            },
            NAMES
        );
        expect(markdown).not.toContain("Summary of everything");
        expect(markdown).toContain("---\n\n_Compactada sola_");
        expect(markdown.match(/## Polar/g)).toHaveLength(1);
        expect(markdown).toContain("Next answer");
    });

    it("writes a view Polar drew as its Markdown, and leaves out one that never drew", () => {
        const at = new Date(0).toISOString();
        const markdown = exporter.threadMarkdown(
            {
                id: ID,
                title: "Plans",
                createdAt: at,
                updatedAt: at,
                truncated: false,
                messages: [
                    {
                        id: "a",
                        parentId: null,
                        role: "assistant",
                        parts: [
                            { type: "text", text: "Here they are." },
                            {
                                type: "tool-polar_show",
                                state: "output-available",
                                input: {
                                    view: {
                                        kind: "table",
                                        columns: [{ label: "Plan" }, { label: "Price" }],
                                        rows: [["Pro", 12]]
                                    }
                                }
                            },
                            {
                                type: "tool-polar_show",
                                state: "output-error",
                                input: { view: { kind: "x" } }
                            }
                        ],
                        metadata: null,
                        createdAt: at
                    }
                ]
            },
            NAMES
        );
        expect(markdown).toContain(
            "Here they are.\n\n| Plan | Price |\n| --- | --- |\n| Pro | 12 |"
        );
        expect(markdown).not.toContain("Usó polar_show");
    });

    it("writes the newest path as Markdown, tools and files by name only", async () => {
        const thread = (await exporter.readExportThread("u1", ID))!;
        const markdown = exporter.threadMarkdown(thread, NAMES);
        expect(markdown).toContain("# Trip to Lisbon");
        expect(markdown).toContain("Edited question");
        expect(markdown).toContain("Second answer");
        expect(markdown).not.toContain("First answer");
        expect(markdown).not.toMatch(/File:|Used |Recortado/);
        const labelled = exporter.threadMarkdown(
            {
                ...thread,
                title: " ",
                messages: [
                    {
                        id: "x",
                        parentId: null,
                        role: "user",
                        parts: [{ type: "file" }, { type: "tool-search" }],
                        metadata: null,
                        createdAt: ""
                    }
                ]
            },
            NAMES
        );
        expect(labelled).toContain("# Conversación");
        expect(labelled).toContain("> Archivo: adjunto");
        expect(labelled).toContain("> Usó search");
    });

    it("says when a chat is longer than one export carries", async () => {
        const many = Array.from({ length: 5001 }, (_, n) => ({
            id: `m${n}`,
            parentId: n === 5000 ? null : `m${n + 1}`,
            role: n % 2 ? "user" : "assistant",
            parts: [{ type: "text", text: `t${n}` }],
            metadata: null,
            createdAt: at(0)
        }));
        state.thread = { ...stored(), messages: many };
        const thread = (await exporter.readExportThread("u1", ID))!;
        expect(thread.truncated).toBe(true);
        expect(thread.messages).toHaveLength(5000);
        expect(thread.messages.some((message) => message.id === "m5000")).toBe(false);
        expect(exporter.threadMarkdown(thread, NAMES)).toContain("> Recortado");
        expect(JSON.parse(exporter.threadJson(thread)).truncated).toBe(true);
        state.thread = stored();
        expect((await exporter.readExportThread("u1", ID))!.truncated).toBe(false);
    });

    it("keeps every version in JSON", async () => {
        const thread = (await exporter.readExportThread("u1", ID))!;
        const parsed = JSON.parse(exporter.threadJson(thread));
        expect(parsed.messages.map((message: { id: string }) => message.id)).toEqual([
            "u1",
            "a1",
            "u2",
            "a2"
        ]);
        expect(parsed.version).toBe(1);
    });

    it("follows a single chain and names files safely", () => {
        const path = exporter.newestPath([
            { id: "1", parentId: null, role: "user", parts: [], metadata: null, createdAt: "" },
            { id: "2", parentId: "1", role: "assistant", parts: [], metadata: null, createdAt: "" }
        ]);
        expect(path.map((message) => message.id)).toEqual(["1", "2"]);
        expect(exporter.exportFileName('Ünïcode "quotes"/../x', ID, "md")).toBe(
            "unicode-quotes-x-11111111.md"
        );
        expect(exporter.exportFileName("日本", ID, "json")).toBe("chat-11111111.json");
    });
});

describe("routes", () => {
    const params = { params: Promise.resolve({ id: ID }) };

    it("downloads one chat as Markdown or JSON", async () => {
        const markdown = await single.GET(new Request("http://x?format=markdown"), params);
        expect(markdown.headers.get("content-disposition")).toBe(
            'attachment; filename="trip-to-lisbon-11111111.md"'
        );
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
        const response = await all.GET(new Request("http://x"));
        expect(response.headers.get("content-type")).toBe("application/zip");
        const bytes = new Uint8Array(await response.arrayBuffer());
        const text = new TextDecoder().decode(bytes);
        expect(text).toContain("markdown/trip-to-lisbon-11111111.md");
        expect(text).toContain("json/trip-to-lisbon-11111111.json");
        expect(state.listArgs).toMatchObject({ where: { userId: "u1", temporary: false } });
    });

    it("pages through every saved chat instead of stopping at a limit", async () => {
        const row = (n: number) => ({ id: `t${n}`, title: `Chat ${n}`, updatedAt: at(5) });
        state.pages = [Array.from({ length: 200 }, (_, n) => row(n)), [row(200)]];
        const text = new TextDecoder().decode(
            new Uint8Array(await (await all.GET(new Request("http://x"))).arrayBuffer())
        );
        expect(text).toContain("markdown/chat-200-t200.md");
        expect(state.listCalls).toHaveLength(2);
        expect(state.listCalls[1]).toMatchObject({ cursor: { id: "t199" }, skip: 1 });
    });
});
