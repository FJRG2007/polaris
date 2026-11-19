/**
 * A button or a form under a message, pressed: what it runs comes from the
 * stored message, only the one it is for may press it, and `/task`'s form
 * makes one task however many times it is sent.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ASKER = "0190a1b2-0000-7000-8000-000000000001";
const OTHER = "0190a1b2-0000-7000-8000-000000000002";
const MESSAGE = "0190a1b2-0000-7000-8000-0000000000aa";

let stored: Record<string, any>;
let editedAt: Date | null;
let inChannel = true;
let toolAnswer: unknown;
const toolCalls: { name: string; input: unknown }[] = [];
const retried: { mention: Record<string, unknown>; replace: string | null }[] = [];

vi.mock("@polaris/db", () => ({
    Prisma: {},
    prisma: {
        chatMessage: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                where.id === MESSAGE
                    ? stored
                    : where.id === "asked"
                      ? { id: "asked", channelId: "c1", authorId: ASKER, parentId: null, body: "@polar hi", deletedAt: null }
                      : null,
            updateMany: async ({ where }: { where: { editedAt: null } }) => {
                if (where.editedAt === null && editedAt !== null) return { count: 0 };
                editedAt = new Date();
                return { count: 1 };
            },
            update: async ({ data }: { data: Record<string, unknown> }) => {
                if ("editedAt" in data) editedAt = data.editedAt as Date | null;
                Object.assign(stored, data);
                return {};
            }
        }
    }
}));
vi.mock("@/lib/chat/access", async () => {
    const actual = await vi.importActual<typeof import("@/lib/chat/access")>("@/lib/chat/access");
    return { ...actual, channelAccess: async () => (inChannel ? { channelId: "c1" } : null) };
});
vi.mock("@/lib/chat/text", async () => ({
    ...(await vi.importActual<typeof import("@/lib/chat/text")>("@/lib/chat/text")),
    chatWordsFor: async () => (key: string) => key
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/mcp/session-call", () => ({
    sessionCaller: async (user: { id: string }) => ({ userId: user.id, scopes: [] }),
    callSessionTool: async (_caller: unknown, name: string, input: unknown) => {
        toolCalls.push({ name, input });
        return toolAnswer;
    }
}));
vi.mock("@/lib/chat/polar-mention", () => ({
    answerPolarMention: async (mention: Record<string, unknown>, replace: string | null) => {
        retried.push({ mention, replace });
        return replace;
    }
}));

const { pressComponent } = await import("@/lib/chat/component-actions");
const { ChatAccessError } = await import("@/lib/chat/access");

const asker = { id: ASKER, isAdmin: false };
const other = { id: OTHER, isAdmin: false };

function taskForm() {
    return {
        id: MESSAGE,
        channelId: "c1",
        replyToId: "q1",
        deletedAt: null,
        components: [
            {
                type: "form",
                label: "New task",
                action: "tasks.create",
                title: "New task",
                submit: "Create",
                for: ASKER,
                fields: [
                    { name: "name", label: "Title", kind: "text", required: true, max: 200 },
                    {
                        name: "list",
                        label: "List",
                        kind: "choice",
                        required: true,
                        options: [{ value: "l1", label: "Work / Inbox" }]
                    },
                    { name: "description", label: "Description", kind: "long", max: 4000 }
                ]
            }
        ]
    };
}

async function refusal(run: Promise<unknown>): Promise<string | null> {
    try {
        await run;
        return null;
    } catch (caught) {
        expect(caught).toBeInstanceOf(ChatAccessError);
        return (caught as InstanceType<typeof ChatAccessError>).text.key;
    }
}

beforeEach(() => {
    stored = taskForm();
    editedAt = null;
    inChannel = true;
    toolAnswer = { ok: true, structured: { id: "t1", reference: "WRK-7" } };
    toolCalls.length = 0;
    retried.length = 0;
});

describe("a press", () => {
    it("is refused to somebody the component is not for, and to somebody no longer in the conversation", async () => {
        const fields = { name: "Milk", list: "l1" };
        expect(await refusal(pressComponent(other, { messageId: MESSAGE, index: 0, fields }))).toBe(
            "errors.componentNotYours"
        );
        inChannel = false;
        expect(await refusal(pressComponent(asker, { messageId: MESSAGE, index: 0, fields }))).toBe(
            "errors.componentGone"
        );
        expect(toolCalls).toHaveLength(0);
    });

    it("runs nothing for a position with no button, or a link", async () => {
        expect(await refusal(pressComponent(asker, { messageId: MESSAGE, index: 3 }))).toBe("errors.componentGone");
        stored = { ...stored, components: [{ type: "link", label: "Open", href: "/tasks" }] };
        expect(await refusal(pressComponent(asker, { messageId: MESSAGE, index: 0 }))).toBe("errors.componentGone");
    });
});

describe("`/task`'s form, sent", () => {
    it("checks the answers against the stored form, not the request", async () => {
        const sent = pressComponent(asker, { messageId: MESSAGE, index: 0, fields: { name: "Milk", list: "not-offered" } });
        expect(await refusal(sent)).toBe("errors.componentInvalid");
        expect(toolCalls).toHaveLength(0);
    });

    it("makes the task through the Tasks tool and replaces the form with a link to it", async () => {
        await pressComponent(asker, { messageId: MESSAGE, index: 0, fields: { name: " Milk ", list: "l1" } });
        expect(toolCalls).toEqual([{ name: "tasks_create", input: { list: "l1", name: "Milk", description: "" } }]);
        expect(stored.body).toBe("appCommands.task.created");
        expect(stored.components).toEqual([{ type: "link", label: "appCommands.task.openTask", href: "/tasks/t/t1" }]);
    });

    it("makes one task when it is sent twice", async () => {
        const fields = { name: "Milk", list: "l1" };
        await pressComponent(asker, { messageId: MESSAGE, index: 0, fields });
        stored = { ...taskForm(), body: stored.body };
        expect(await refusal(pressComponent(asker, { messageId: MESSAGE, index: 0, fields }))).toBe(
            "errors.componentGone"
        );
        expect(toolCalls).toHaveLength(1);
    });

    it("can be sent again after Tasks refused it", async () => {
        toolAnswer = { ok: false, reason: "refused", message: "No list" };
        const fields = { name: "Milk", list: "l1" };
        expect(await refusal(pressComponent(asker, { messageId: MESSAGE, index: 0, fields }))).toBe(
            "errors.taskNotCreated"
        );
        expect(editedAt).toBeNull();
        toolAnswer = { ok: true, structured: { id: "t2", reference: "WRK-8" } };
        await pressComponent(asker, { messageId: MESSAGE, index: 0, fields });
        expect(toolCalls).toHaveLength(2);
    });
});

describe("Polar's Try again", () => {
    beforeEach(() => {
        stored = {
            id: MESSAGE,
            channelId: "c1",
            replyToId: "asked",
            deletedAt: null,
            components: [{ type: "button", label: "Try again", action: "polar.retry", for: ASKER }]
        };
    });

    it("asks the same question again for the one who asked, written over the reply", async () => {
        await pressComponent(asker, { messageId: MESSAGE, index: 0 });
        expect(retried).toEqual([
            {
                mention: { channelId: "c1", messageId: "asked", authorId: ASKER, parentId: null, body: "@polar hi" },
                replace: MESSAGE
            }
        ]);
    });

    it("is never pressed on somebody else's behalf, even without a `for`", async () => {
        stored = { ...stored, components: [{ type: "button", label: "Try again", action: "polar.retry" }] };
        expect(await refusal(pressComponent(other, { messageId: MESSAGE, index: 0 }))).toBe("errors.componentNotYours");
        expect(retried).toHaveLength(0);
    });
});
