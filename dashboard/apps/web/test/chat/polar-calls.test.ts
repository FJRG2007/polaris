/**
 * `@polar` with tools in Chat: reads run as the asker, a change only waits for
 * their approval, tools over secrets are never offered, and only the asker can
 * approve or cancel - once.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ran: { tool: string; input: unknown }[] = [];
const answered: unknown[][] = [];
let row: Record<string, unknown> | null = null;
let claimed = 1;

function entry(name: string, category: string, writes: boolean) {
    return { name, category, writes };
}

const catalogue = [
    entry("tasks_list", "tasks", false),
    entry("tasks_create", "tasks", true),
    entry("vault_items", "vault", false),
    entry("mail_send", "mail", true)
];

vi.mock("@polaris/db", () => ({
    prisma: {
        polarChatCall: {
            findUnique: async () => row,
            deleteMany: async () => ({ count: claimed })
        },
        chatMessage: {
            findUnique: async () => ({
                id: "q1",
                channelId: "c1",
                authorId: "u1",
                parentId: null,
                body: "@polar make a task",
                deletedAt: null
            })
        }
    }
}));
vi.mock("@/lib/mcp/acting-user", () => ({
    actingUser: async (id: string) => ({ id, email: "", name: "Ana", isAdmin: false, sessionId: "" })
}));
vi.mock("@/lib/polar/tools", () => ({
    polarTools: async () => ({
        catalog: catalogue.map(({ name, category }) => ({ name, category, description: `${name} tool` })),
        tools: Object.fromEntries(
            catalogue.map(({ name }) => [
                name,
                {
                    description: `${name} tool`,
                    inputSchema: {},
                    execute: async (input: unknown) => {
                        ran.push({ tool: name, input });
                        return { ok: true, text: `${name} ran` };
                    }
                }
            ])
        ),
        described: Object.fromEntries(
            catalogue.map(({ name, category, writes }) => [name, { title: name, category, writes, destructive: false }])
        ),
        approval: {}
    })
}));
vi.mock("ai", () => ({
    tool: (definition: unknown) => definition
}));
vi.mock("@/lib/chat/polar-mention", () => ({
    answerPolarMention: async (...args: unknown[]) => {
        answered.push(args);
        return "m1";
    }
}));
vi.mock("@/lib/chat/text", () => ({
    chatWordsFor: async () => (key: string) => key,
    chatText: (_locale: string, text: { key: string }) => text.key
}));

const calls = await import("@/lib/chat/polar-calls");

function pressed(userId: string, value = "call1") {
    const updates: unknown[] = [];
    return {
        updates,
        press: {
            user: { id: userId, isAdmin: false },
            message: { id: "m1", channelId: "c1", replyToId: "q1", parentId: null, agent: "polar", authorLabel: "Polar" },
            value,
            values: [],
            fields: {},
            update: async (patch: unknown) => {
                updates.push(patch);
            },
            followUp: async () => "f1"
        }
    };
}

beforeEach(() => {
    ran.length = 0;
    answered.length = 0;
    claimed = 1;
    row = {
        id: "call1",
        ownerId: "u1",
        messageId: "m1",
        mentionId: "q1",
        tool: "tasks_create",
        input: { list: "Inbox", name: "Fix staging" },
        done: [],
        createdAt: new Date()
    };
});

describe("the tools a mention offers", () => {
    it("runs reads, holds a change without running it, and offers nothing over secrets", async () => {
        const kit = await calls.mentionToolkit("u1");
        expect(kit).not.toBeNull();
        const tools = kit!.tools as Record<string, { execute: (input: unknown) => Promise<{ text: string }> }>;
        expect(Object.keys(tools).sort()).toEqual(["find_tools", "mail_send", "tasks_create", "tasks_list"]);

        await tools.tasks_list!.execute({});
        expect(ran).toEqual([{ tool: "tasks_list", input: {} }]);

        const waiting = await tools.tasks_create!.execute({ list: "Inbox" });
        expect(waiting.text).toContain("Not run yet");
        expect(kit!.pending()).toEqual({ tool: "tasks_create", title: "tasks_create", input: { list: "Inbox" } });
        // One change at a time: a second is refused, the first still waits.
        const second = await tools.mail_send!.execute({ to: "x" });
        expect(second.text).toContain("only one change");
        expect(kit!.pending()?.tool).toBe("tasks_create");
        expect(ran).toHaveLength(1);
    });
});

describe("approving a change", () => {
    it("runs it as the asker and answers the mention again with what was done", async () => {
        const { press } = pressed("u1");
        await calls.approveCall(press as never);
        expect(ran).toEqual([{ tool: "tasks_create", input: { list: "Inbox", name: "Fix staging" } }]);
        expect(answered[0]?.[1]).toBe("m1");
        expect(answered[0]?.[2]).toEqual([{ tool: "tasks_create", title: "tasks_create", ok: true, text: "tasks_create ran" }]);
    });

    it("is refused to anybody but the asker, and runs nothing", async () => {
        const { press } = pressed("u2");
        await expect(calls.approveCall(press as never)).rejects.toMatchObject({
            text: { key: "errors.componentNotYours" }
        });
        expect(ran).toHaveLength(0);
    });

    it("runs once when pressed twice", async () => {
        claimed = 0;
        const { press } = pressed("u1");
        await expect(calls.approveCall(press as never)).rejects.toBeTruthy();
        expect(ran).toHaveLength(0);
    });

    it("never runs a call from another message", async () => {
        row = { ...row, messageId: "other" };
        const { press } = pressed("u1");
        await expect(calls.approveCall(press as never)).rejects.toBeTruthy();
        expect(ran).toHaveLength(0);
    });

    it("never runs one left waiting past its day", async () => {
        row = { ...row, createdAt: new Date(Date.now() - calls.CALL_TTL_MS - 1000) };
        const { press } = pressed("u1");
        await expect(calls.approveCall(press as never)).rejects.toBeTruthy();
        expect(ran).toHaveLength(0);
    });
});

describe("cancelling a change", () => {
    it("runs nothing and says so on the message", async () => {
        const { press, updates } = pressed("u1");
        await calls.cancelCall(press as never);
        expect(ran).toHaveLength(0);
        expect(updates).toEqual([{ body: "polar.callCancelled", components: [] }]);
    });
});

describe("a change as it is shown", () => {
    it("names it and lists its fields, cut short", () => {
        const text = calls.describeCall(
            { tool: "tasks_create", title: "Create task", input: { name: "a\nb", empty: "", long: "x".repeat(300) } },
            (title) => `**${title}**`
        );
        const lines = text.split("\n");
        expect(lines[0]).toBe("**Create task**");
        expect(lines[1]).toBe("- name: a b");
        expect(lines[2]!.length).toBeLessThan(220);
        expect(lines).toHaveLength(3);
    });
});
