/**
 * `/polar` and `/task` in any conversation: offered and run only for somebody
 * who can use the app, answered as the app, and `/task` answered with a form
 * only the one who asked can fill in.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let polarUse = true;
let tasksManage = true;
let body = "/task Buy milk";
let lists: unknown = [{ name: "Work", lists: [{ id: "l1", name: "Inbox" }] }];
const asked: Record<string, unknown>[] = [];
const posted: Record<string, any>[] = [];

vi.mock("@polaris/auth", () => ({ can: async () => tasksManage }));
vi.mock("@polaris/db", () => ({
    prisma: {
        chatMessage: {
            findUnique: async () => ({
                body,
                channelId: "c1",
                parentId: null,
                kind: "text",
                deletedAt: null,
                authorId: "u1"
            })
        },
        user: { findUnique: async () => ({ isAdmin: false }) }
    }
}));
vi.mock("@/lib/chat/access", () => ({ channelAccess: async () => ({ channelId: "c1" }) }));
vi.mock("@/lib/chat/text", () => ({ chatWordsFor: async () => (key: string) => key }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/polar/access", () => ({ polarAccessFor: async () => ({ use: polarUse }) }));
vi.mock("@/lib/chat/agent-message", () => ({
    postAgentMessage: async (input: Record<string, unknown>) => {
        posted.push(input);
        return "m1";
    }
}));
vi.mock("@/lib/chat/polar-mention", () => ({
    answerPolarMention: async (mention: Record<string, unknown>) => {
        asked.push(mention);
        return "m1";
    }
}));
vi.mock("@/lib/mcp/session-call", () => ({
    sessionCaller: async () => ({}),
    callSessionTool: async () => ({ ok: true, structured: { spaces: lists } })
}));

const { appCommandsFor, runAppCommand } = await import("@/lib/chat/app-commands");

beforeEach(() => {
    polarUse = true;
    tasksManage = true;
    body = "/task Buy milk";
    lists = [{ name: "Work", lists: [{ id: "l1", name: "Inbox" }] }];
    asked.length = 0;
    posted.length = 0;
});

describe("the commands offered", () => {
    it("are only those of the apps this person can use", async () => {
        expect((await appCommandsFor("u1")).map((command) => command.name)).toEqual(["polar", "task"]);
        polarUse = false;
        expect((await appCommandsFor("u1")).map((command) => command.name)).toEqual(["task"]);
        tasksManage = false;
        expect(await appCommandsFor("u1")).toEqual([]);
    });
});

describe("a command sent", () => {
    it("`/polar` asks Polar, as the one who wrote it", async () => {
        body = "/polar what changed?";
        await runAppCommand("q1", "u1");
        expect(asked).toEqual([
            { channelId: "c1", messageId: "q1", authorId: "u1", parentId: null, body: "/polar what changed?" }
        ]);
    });

    it("`/task` is answered by Tasks with a form for the one who asked, the title already in it", async () => {
        await runAppCommand("q1", "u1");
        expect(posted).toHaveLength(1);
        expect(posted[0]).toMatchObject({ agent: "tasks", replyToId: "q1", body: "appCommands.task.prompt" });
        const form = posted[0]!.components[0];
        expect(form).toMatchObject({ type: "form", action: "tasks.create", for: "u1" });
        expect(form.fields[0]).toMatchObject({ name: "name", value: "Buy milk", required: true });
        expect(form.fields[1]).toMatchObject({ name: "list", options: [{ value: "l1", label: "Work / Inbox" }] });
    });

    it("`/task` with no list to add to says so, with the way to Tasks", async () => {
        lists = [];
        await runAppCommand("q1", "u1");
        expect(posted[0]).toMatchObject({ body: "appCommands.task.noLists" });
        expect(posted[0]!.components).toEqual([{ type: "link", label: "appCommands.task.openTasks", href: "/tasks" }]);
    });

    it("runs nothing for somebody who cannot use the app, or for a message somebody else wrote", async () => {
        tasksManage = false;
        await runAppCommand("q1", "u1");
        tasksManage = true;
        await runAppCommand("q1", "u2");
        expect(posted).toHaveLength(0);
    });
});
