/**
 * The instance's spam limits: loose enough that talking normally never meets
 * them, firm on the clear abuse - the room pinged again and again, one person
 * mentioned over and over, the same line pasted repeatedly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    channelId: string;
    authorId: string;
    body: string;
    createdAt: Date;
}

const rows: Row[] = [];

function matches(row: Row, where: Record<string, unknown>): boolean {
    if (where.channelId && row.channelId !== where.channelId) return false;
    if (where.authorId && row.authorId !== where.authorId) return false;
    const created = where.createdAt as { gte: Date } | undefined;
    if (created && row.createdAt < created.gte) return false;
    if (typeof where.body === "string" && row.body !== where.body) return false;
    const contains = (where.body as { contains?: string } | undefined)?.contains;
    if (contains && !row.body.includes(contains)) return false;
    const any = where.OR as { body: { contains: string } }[] | undefined;
    if (any && !any.some((one) => row.body.includes(one.body.contains))) return false;
    return true;
}

vi.mock("@polaris/db", () => ({
    prisma: {
        chatMessage: {
            count: async ({ where }: { where: Record<string, unknown> }) =>
                rows.filter((row) => matches(row, where)).length,
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                rows.filter((row) => matches(row, where))
        }
    }
}));

const core = await import("@polaris/core");
const { requireNotSpam, requireRoomMentionAllowed } = await import("@/lib/chat/spam-guard");

const NOW = Date.parse("2026-09-28T20:00:00Z");
const ANA = "0193aaaa-0000-7000-8000-000000000001";
const rules = core.DEFAULT_CHAT_RULES;

const said = (body: string, minutesAgo: number, authorId = "me") =>
    rows.push({
        channelId: "room",
        authorId,
        body,
        createdAt: new Date(NOW - minutesAgo * 60_000)
    });

const send = (
    body: string,
    options: { moderator?: boolean; editing?: boolean; with?: core.ChatRules } = {}
) =>
    requireNotSpam({
        rules: options.with ?? rules,
        channelId: "room",
        authorId: "me",
        body,
        moderator: options.moderator ?? false,
        editing: options.editing,
        now: NOW
    });

const mention = (id: string, name = "Ana") => `[@${name}](polaris:user/${id})`;

beforeEach(() => {
    rows.length = 0;
});

describe("@everyone and @here", () => {
    it("are fine a few times an hour", async () => {
        said("@everyone standup in 5", 50);
        said("@here anyone around?", 20);
        await expect(send("@everyone lunch")).resolves.toBeUndefined();
    });

    it("stop at the fourth in an hour, and say so", async () => {
        said("@everyone one", 50);
        said("@here two", 30);
        said("@all three", 10);
        await expect(send("@everyone four")).rejects.toThrow(
            "@everyone and @here can be used 3 times an hour per person here"
        );
    });

    it("do not count once the hour has passed, or somebody else's, or one in code", async () => {
        said("@everyone old", 61);
        said("@everyone theirs", 5, "someone-else");
        said("`@everyone` is how you ping the room", 5);
        said("@everyone recent", 5);
        await expect(send("@everyone again")).resolves.toBeUndefined();
    });

    it("never hold whoever moderates the room", async () => {
        for (let index = 0; index < 5; index += 1) said(`@everyone ${index}`, index);
        await expect(send("@everyone announcement", { moderator: true })).resolves.toBeUndefined();
    });

    it("hold an edit that adds one, just like a send", async () => {
        for (let index = 0; index < 3; index += 1) said(`@here ${index}`, index);
        await expect(
            requireRoomMentionAllowed({ rules, channelId: "room", authorId: "me", now: NOW })
        ).rejects.toThrow(/an hour/);
    });
});

describe("mentioning people", () => {
    it("allows a long list, not a phone book", async () => {
        const many = (count: number) =>
            Array.from({ length: count }, (_, index) =>
                mention(`0193aaaa-0000-7000-8000-${String(index).padStart(12, "0")}`, `P${index}`)
            ).join(" ");
        await expect(send(many(20))).resolves.toBeUndefined();
        await expect(send(many(21))).rejects.toThrow(
            "One message can mention up to 20 people here"
        );
        // And an edit cannot get round it.
        await expect(send(many(21), { editing: true })).rejects.toThrow(/up to 20/);
    });

    it("stops the same person being mentioned over and over", async () => {
        for (let index = 0; index < 5; index += 1) said(`${mention(ANA)} ping ${index}`, index);
        await expect(send(`${mention(ANA)} ping again`)).rejects.toThrow(
            "mentioned the same person a lot"
        );
        // Somebody else is fine, and so is Ana ten minutes later.
        await expect(
            send(mention("0193aaaa-0000-7000-8000-000000000002", "Ben"))
        ).resolves.toBeUndefined();
        rows.length = 0;
        for (let index = 0; index < 5; index += 1)
            said(`${mention(ANA)} ping ${index}`, 11 + index);
        await expect(send(`${mention(ANA)} hi`)).resolves.toBeUndefined();
    });

    it("counts a mention however its address is cased", async () => {
        for (let index = 0; index < 5; index += 1)
            said(`[@Ana](POLARIS:user/${ANA.toUpperCase()}) ping ${index}`, index);
        await expect(send(`${mention(ANA)} again`)).rejects.toThrow(
            "mentioned the same person a lot"
        );
        await expect(send(`[@Ana](polaris:USER/${ANA.toUpperCase()}) again`)).rejects.toThrow(
            "mentioned the same person a lot"
        );
    });

    it("does not count an address inside code", async () => {
        for (let index = 0; index < 5; index += 1) said(`\`polaris:user/${ANA}\` ${index}`, index);
        await expect(send(`${mention(ANA)} hi`)).resolves.toBeUndefined();
    });
});

describe("the same message again", () => {
    it("lets it through twice more, not a fourth time in two minutes", async () => {
        said("buy cheap gold", 1.5);
        said("buy cheap gold", 1);
        await expect(send("buy cheap gold")).resolves.toBeUndefined();
        said("buy cheap gold", 0.5);
        await expect(send("buy cheap gold")).rejects.toThrow("same message several times");
        await expect(send("ok")).resolves.toBeUndefined();
    });
});

describe("the operator's switch", () => {
    it("turns every one of these off at once", async () => {
        for (let index = 0; index < 10; index += 1) said("@everyone spam", 0);
        await expect(
            send("@everyone spam", { with: { ...rules, spamGuard: false } })
        ).resolves.toBeUndefined();
    });

    it("turns a single limit off with zero", async () => {
        for (let index = 0; index < 10; index += 1) said(`@everyone ${index}`, index);
        await expect(
            send("@everyone more", { with: { ...rules, maxRoomMentionsPerHour: 0 } })
        ).resolves.toBeUndefined();
    });
});
