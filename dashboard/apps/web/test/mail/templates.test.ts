/**
 * Message templates: who may make one, and what they may call it.
 *
 * Three rules. A template tied to a mailbox must be tied to one of the person's
 * own; two templates may not share a name, because a menu of two identical
 * entries is a menu nobody can use; and changing or deleting one is narrowed by
 * the person inside the query, so a guessed id reaches nothing.
 */

import { mailTemplateSchema } from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

let clash: { id: string } | null = null;
let updated = 0;
let lastUpdateWhere: unknown = null;
let lastDeleteWhere: unknown = null;
const owned = new Set<string>(["11111111-1111-4111-8111-111111111111"]);

vi.mock("@polaris/db", () => ({
    prisma: {
        mailTemplate: {
            findFirst: async () => clash,
            create: async () => ({ id: "t-new" }),
            updateMany: async (query: { where: unknown }) => {
                lastUpdateWhere = query.where;
                return { count: updated };
            },
            deleteMany: async (query: { where: unknown }) => {
                lastDeleteWhere = query.where;
                return { count: 1 };
            },
            findMany: async () => []
        }
    }
}));

vi.mock("@/lib/mailbox/access", () => {
    class MailAccessError extends Error {}
    return {
        MailAccessError,
        ownedAccount: async (_userId: string, accountId: string) => {
            if (!owned.has(accountId)) throw new MailAccessError("That mailbox is not yours.");
            return { id: accountId };
        }
    };
});

const templates = await import("@/lib/mailbox/templates");

beforeEach(() => {
    clash = null;
    updated = 1;
    lastUpdateWhere = null;
    lastDeleteWhere = null;
});

const input = (over: Partial<Record<string, unknown>> = {}) =>
    mailTemplateSchema.parse({ name: "Invoice follow-up", body: "Here it is.", ...over });

describe("making a template", () => {
    it("makes one aimed at every mailbox", async () => {
        expect(await templates.saveTemplate("u1", null, input())).toBe("t-new");
    });

    it("refuses one aimed at a mailbox that is not the person's", async () => {
        await expect(
            templates.saveTemplate(
                "u1",
                null,
                input({ accountId: "22222222-2222-4222-8222-222222222222" })
            )
        ).rejects.toThrow("not yours");
    });

    it("refuses a second template with the same name", async () => {
        clash = { id: "t-old" };
        await expect(templates.saveTemplate("u1", null, input())).rejects.toBeInstanceOf(
            templates.MailTemplateNameTaken
        );
    });
});

describe("changing and deleting one", () => {
    it("narrows both by the person inside the query", async () => {
        await templates.saveTemplate("u1", "t-1", input());
        expect(lastUpdateWhere).toEqual({ id: "t-1", userId: "u1" });
        await templates.deleteTemplate("u1", "t-1");
        expect(lastDeleteWhere).toEqual({ id: "t-1", userId: "u1" });
    });

    it("says it is not theirs when nothing of theirs matched", async () => {
        updated = 0;
        await expect(templates.saveTemplate("u1", "t-else", input())).rejects.toThrow("not yours");
    });
});

describe("what a template must say", () => {
    it("needs a name and a body, and trims the name", () => {
        expect(mailTemplateSchema.safeParse({ name: " ", body: "x" }).success).toBe(false);
        expect(mailTemplateSchema.safeParse({ name: "Hi", body: "   " }).success).toBe(false);
        expect(mailTemplateSchema.parse({ name: "  Hi  ", body: "x" }).name).toBe("Hi");
    });
});
