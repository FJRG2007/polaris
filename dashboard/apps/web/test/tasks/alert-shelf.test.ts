/**
 * Tasks alerts are filed on the shelf their space is on.
 *
 * Tasks lists a company's spaces on that company's shelf and somebody's own on
 * the personal one; an alert about a task is counted on the bell the same way,
 * or the bell on one shelf points at work only another shelf lists.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const spaces: Record<string, string | null> = { acme: "org-acme", home: null };
const tasks: Record<string, string> = { "t-acme": "acme", "t-home": "home" };
const sent: Array<{ userId: string; event: string; shelf?: { orgId: string | null } }> = [];

vi.mock("@polaris/db", () => ({
    VISIBLE_USER: {},
    prisma: {
        taskSpace: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                where.id in spaces ? { orgId: spaces[where.id] } : null
        },
        task: {
            findUnique: async ({ where }: { where: { id: string } }) => {
                const space = tasks[where.id];
                return space ? { space: { orgId: spaces[space] } } : null;
            }
        },
        teamMember: { findMany: async () => [] },
        user: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.map((id) => ({ id, isAdmin: false }))
        },
        taskReminder: {
            findMany: async () => [
                {
                    id: "r1",
                    userId: "u2",
                    note: "",
                    taskId: "t-acme",
                    remindAt: new Date(),
                    task: { name: "Invoice", space: { orgId: "org-acme" } }
                }
            ],
            update: async () => ({})
        }
    }
}));
vi.mock("@/lib/tasks/access", () => ({ resolveSpaceRole: async () => "member" }));
vi.mock("@/lib/notifications/dispatch", () => ({
    notify: async (input: (typeof sent)[number]) => {
        sent.push(input);
    }
}));

const { spaceShelf, taskShelf } = await import("@/lib/tasks/shelf");
const { notifyMentions } = await import("@/lib/rich-text/mention-notify");
const { dispatchDueReminders } = await import("@/lib/tasks/task-detail-service");

const ANA = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
    sent.length = 0;
});

describe("the shelf of a piece of Tasks work", () => {
    it("is the space's organization, or the personal shelf for somebody's own", async () => {
        expect(await spaceShelf("acme")).toEqual({ orgId: "org-acme" });
        expect(await spaceShelf("home")).toEqual({ orgId: null });
        expect(await taskShelf("t-acme")).toEqual({ orgId: "org-acme" });
        expect(await taskShelf("t-home")).toEqual({ orgId: null });
    });

    it("is about the account when the work is gone, so the alert is still seen", async () => {
        expect(await spaceShelf("gone")).toBeUndefined();
        expect(await spaceShelf(null)).toBeUndefined();
        expect(await taskShelf("gone")).toBeUndefined();
    });
});

describe("alerts about Tasks work", () => {
    it("files a mention on the shelf of the space it was written in", async () => {
        await notifyMentions({
            body: `Can you look? [@Ana](polaris:user/${ANA})`,
            actorId: "u1",
            title: "Invoice",
            href: "/tasks/t/t-acme",
            spaceId: "acme"
        });
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ userId: ANA, event: "tasks.mentioned", shelf: { orgId: "org-acme" } });
    });

    it("files a reminder on the shelf of its task", async () => {
        await dispatchDueReminders(new Date());
        expect(sent[0]).toMatchObject({ userId: "u2", event: "tasks.due", shelf: { orgId: "org-acme" } });
    });
});
