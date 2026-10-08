/**
 * A channel's incoming webhooks.
 *
 * What is asserted is what makes the address safe to hand to a script: only the
 * secret's hash is stored, a wrong secret and an unknown id are the same answer,
 * resetting stops the old address at once, only whoever runs the channel manages
 * them, and a message posted through one carries the name it was posted under
 * and no account.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Hook {
    id: string;
    channelId: string;
    name: string;
    tokenHash: string;
    createdById: string | null;
    createdAt: Date;
    lastUsedAt: Date | null;
}

const db = vi.hoisted(() => ({
    hooks: [] as Hook[],
    messages: [] as Array<Record<string, unknown>>,
    access: { spaceId: "s1", mayAdminister: true } as { spaceId: string | null; mayAdminister: boolean },
    channel: { archived: false, space: { archived: false } } as {
        archived: boolean;
        space: { archived: boolean } | null;
    } | null,
    published: [] as Array<{ kind: string; channelId: string }>,
    unfurled: [] as string[],
    next: 0
}));

function pick(hook: Hook, select?: Record<string, unknown>) {
    if (!select) return hook;
    return Object.fromEntries(Object.keys(select).map((key) => [key, hook[key as keyof Hook]]));
}

vi.mock("@polaris/db", () => {
    const chatWebhook = {
        findMany: async ({ where }: { where: { channelId: string } }) =>
            db.hooks.filter((hook) => hook.channelId === where.channelId),
        count: async ({ where }: { where: { channelId: string } }) =>
            db.hooks.filter((hook) => hook.channelId === where.channelId).length,
        create: async ({ data, select }: { data: Omit<Hook, "id" | "createdAt" | "lastUsedAt">; select?: Record<string, unknown> }) => {
            db.next += 1;
            const hook: Hook = {
                id: `0190a000-0000-7000-8000-${String(db.next).padStart(12, "0")}`,
                createdAt: new Date(),
                lastUsedAt: null,
                ...data
            };
            db.hooks.push(hook);
            return pick(hook, select);
        },
        findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) => {
            const hook = db.hooks.find((entry) => entry.id === where.id);
            return hook ? pick(hook, select) : null;
        },
        update: async ({ where, data, select }: { where: { id: string }; data: Partial<Hook>; select?: Record<string, unknown> }) => {
            const hook = db.hooks.find((entry) => entry.id === where.id)!;
            Object.assign(hook, data);
            return pick(hook, select);
        },
        updateMany: async ({ where, data }: { where: { id: string }; data: Partial<Hook> }) => {
            const hook = db.hooks.find((entry) => entry.id === where.id);
            if (hook) Object.assign(hook, data);
            return { count: hook ? 1 : 0 };
        },
        delete: async ({ where }: { where: { id: string } }) => {
            db.hooks = db.hooks.filter((entry) => entry.id !== where.id);
        }
    };
    const tx = {
        chatMessage: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
                const message = { id: `m${db.messages.length + 1}`, createdAt: new Date(), ...data };
                db.messages.push(message);
                return message;
            }
        },
        chatChannel: { update: async () => ({}) },
        chatWebhook
    };
    return {
        prisma: {
            chatWebhook,
            chatChannel: { findUnique: async () => db.channel },
            user: { findMany: async () => [{ id: "u1", name: "Ada" }] },
            $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx)
        }
    };
});

vi.mock("@/lib/chat/access", async () => {
    const actual = await vi.importActual<typeof import("@/lib/chat/access")>("@/lib/chat/access");
    return {
        ChatAccessError: actual.ChatAccessError,
        requireChannel: async () => db.access
    };
});

vi.mock("@/lib/chat/live", () => ({
    publishChatChange: (change: { kind: string; channelId: string }) => db.published.push(change)
}));

vi.mock("@/lib/chat/messages", () => ({
    unfurlLater: (body: string) => db.unfurled.push(body)
}));

const webhooks = await import("@/lib/chat/webhooks");
const core = await import("@polaris/core");

const ME = { id: "u1" };
const CHANNEL = "0190a000-0000-7000-8000-0000000000c1";

beforeEach(() => {
    db.hooks = [];
    db.messages = [];
    db.access = { spaceId: "s1", mayAdminister: true };
    db.channel = { archived: false, space: { archived: false } };
    db.published = [];
    db.unfurled = [];
    db.next = 0;
});

describe("making one", () => {
    it("hands the secret back once and keeps only its hash", async () => {
        const made = await webhooks.createWebhook(ME, { channelId: CHANNEL, name: "CI" });
        expect(made.token).toMatch(/^[A-Za-z0-9_-]{48}$/);
        expect(made.webhook).toMatchObject({ name: "CI", createdBy: "Ada", lastUsedAt: null });
        expect(db.hooks[0]!.tokenHash).toBe(createHash("sha256").update(made.token).digest("hex"));
        expect(JSON.stringify(db.hooks[0])).not.toContain(made.token);
        expect(JSON.stringify(await webhooks.listWebhooks(ME, CHANNEL))).not.toContain(made.token);
    });

    it("is refused to somebody who does not run the channel, and outside a space", async () => {
        db.access = { spaceId: "s1", mayAdminister: false };
        await expect(webhooks.createWebhook(ME, { channelId: CHANNEL, name: "CI" })).rejects.toThrow();
        db.access = { spaceId: null, mayAdminister: true };
        await expect(webhooks.listWebhooks(ME, CHANNEL)).rejects.toThrow();
        expect(db.hooks).toEqual([]);
    });

    it("stops at the most a channel holds", async () => {
        for (let index = 0; index < core.MAX_CHAT_WEBHOOKS; index += 1) {
            await webhooks.createWebhook(ME, { channelId: CHANNEL, name: `hook ${index}` });
        }
        await expect(webhooks.createWebhook(ME, { channelId: CHANNEL, name: "one more" })).rejects.toThrow();
    });
});

describe("the address", () => {
    it("opens with the right secret only, and says the same for every wrong one", async () => {
        const made = await webhooks.createWebhook(ME, { channelId: CHANNEL, name: "CI" });
        expect(await webhooks.webhookFor(made.webhook.id, made.token)).toMatchObject({
            channelId: CHANNEL,
            name: "CI"
        });
        expect(await webhooks.webhookFor(made.webhook.id, `${made.token.slice(0, -1)}A`)).toBeNull();
        expect(await webhooks.webhookFor("0190a000-0000-7000-8000-00000000ffff", made.token)).toBeNull();
        expect(await webhooks.webhookFor("not-an-id", made.token)).toBeNull();
        expect(await webhooks.webhookFor(made.webhook.id, "short")).toBeNull();
    });

    it("stops working the moment it is reset", async () => {
        const made = await webhooks.createWebhook(ME, { channelId: CHANNEL, name: "CI" });
        const fresh = await webhooks.resetWebhook(ME, made.webhook.id);
        expect(fresh.token).not.toBe(made.token);
        expect(await webhooks.webhookFor(made.webhook.id, made.token)).toBeNull();
        expect(await webhooks.webhookFor(made.webhook.id, fresh.token)).not.toBeNull();
    });

    it("is gone with the webhook", async () => {
        const made = await webhooks.createWebhook(ME, { channelId: CHANNEL, name: "CI" });
        await webhooks.deleteWebhook(ME, made.webhook.id);
        expect(await webhooks.webhookFor(made.webhook.id, made.token)).toBeNull();
    });
});

describe("posting through one", () => {
    const hook = { id: "0190a000-0000-7000-8000-0000000000h1", channelId: CHANNEL, name: "CI" };

    it("writes a message with no account, under its name or the one asked for", async () => {
        await webhooks.postThroughWebhook(hook, { content: "Build passed https://ci.example" });
        await webhooks.postThroughWebhook(hook, { content: "Deployed", username: "Deploy bot" });
        expect(db.messages[0]).toMatchObject({
            authorId: null,
            webhookId: hook.id,
            authorLabel: "CI",
            body: "Build passed https://ci.example"
        });
        expect(db.messages[1]).toMatchObject({ authorLabel: "Deploy bot" });
        expect(db.published.map((change) => change.kind)).toEqual(["posted", "posted"]);
        expect(db.unfurled[0]).toContain("https://ci.example");
    });

    it("refuses an archived channel", async () => {
        db.channel = { archived: true, space: { archived: false } };
        await expect(webhooks.postThroughWebhook(hook, { content: "x" })).rejects.toThrow();
        db.channel = { archived: false, space: { archived: true } };
        await expect(webhooks.postThroughWebhook(hook, { content: "x" })).rejects.toThrow();
        expect(db.messages).toEqual([]);
    });
});

describe("Discord's body", () => {
    it("takes content and username, ignores the rest, and refuses an empty message", () => {
        const schema = core.chatWebhookExecuteSchema;
        expect(
            schema.safeParse({ content: "hi", username: "Bot", embeds: [], avatar_url: "x" }).success
        ).toBe(true);
        expect(schema.safeParse({ content: "   " }).success).toBe(false);
        expect(schema.safeParse({ username: "Bot" }).success).toBe(false);
        expect(schema.safeParse({ content: "x".repeat(core.MAX_CHAT_MESSAGE + 1) }).success).toBe(false);
        expect(schema.safeParse({ content: "hi", username: "x".repeat(81) }).success).toBe(false);
    });
});
