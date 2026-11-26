/**
 * The sweep of clear reactions and votes left in sealed conversations
 * (docs/chat-e2ee-mls.md, "Sealed reactions"): each person's clear rows become
 * one sealed set or ballot a reader opens with the sweep's key, verified
 * before anything is cut, the clear rows moved to the 30-day rollback copy in
 * the same transaction, rerunnable, and put back by a rollback.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
    sealed: true,
    migration: new Map<string, Row>(),
    messages: [] as Row[],
    reactions: [] as Row[],
    sets: [] as Row[],
    polls: [] as Row[],
    options: [] as Row[],
    votes: [] as Row[],
    ballots: [] as Row[],
    copies: [] as Row[],
    historyKeys: [] as Row[],
    sweptKeys: [] as { epoch: bigint; key: Uint8Array }[]
}));

vi.mock("@polaris/db", () => {
    const relations: Record<string, (row: Row) => Row | undefined> = {
        message: (row) => db.messages.find((m) => m.id === (row.messageId ?? row.pollId)),
        option: (row) => db.options.find((o) => o.id === row.optionId),
        poll: (row) => db.polls.find((p) => p.messageId === row.pollId)
    };
    const matches = (row: Row, where: Row): boolean =>
        Object.entries(where).every(([key, want]) => {
            if (key === "NOT") return !(want as Row[]).some((w) => matches(row, w));
            if (relations[key] && want && typeof want === "object") {
                const related = relations[key]!(row);
                return related !== undefined && matches(related, want as Row);
            }
            if (want && typeof want === "object" && !(want instanceof Uint8Array)) {
                const w = want as { in?: unknown[]; gt?: string; gte?: bigint; lte?: bigint };
                if (w.in) return w.in.includes(row[key]);
                if (w.gt !== undefined) return String(row[key]) > w.gt;
                const value = row[key] as bigint;
                return (w.gte === undefined || value >= w.gte) && (w.lte === undefined || value <= w.lte);
            }
            return row[key] === want;
        });
    const sorted = (rows: Row[], orderBy: unknown): Row[] => {
        const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((o) => Object.keys(o as Row));
        return [...rows].sort((a, b) => {
            for (const key of keys) if (a[key] !== b[key]) return String(a[key]) < String(b[key]) ? -1 : 1;
            return 0;
        });
    };
    const table = (rows: () => Row[], unique?: (where: Row) => Row) => ({
        findMany: async ({ where = {}, take, distinct, orderBy, select }: { where?: Row; take?: number; distinct?: string[]; orderBy?: unknown; select?: Row }) => {
            let found = sorted(rows().filter((r) => matches(r, where)), orderBy);
            if (distinct) {
                const seen = new Set<string>();
                found = found.filter((r) => {
                    const key = distinct.map((d) => String(r[d])).join("/");
                    return seen.has(key) ? false : (seen.add(key), true);
                });
            }
            if (select?.option) found = found.map((r) => ({ ...r, option: relations.option!(r) }));
            if (select?.options) found = found.map((r) => ({ ...r, options: sorted(db.options.filter((o) => o.pollId === r.messageId), { position: "asc" }) }));
            return take ? found.slice(0, take) : found;
        },
        findFirst: async ({ where, orderBy }: { where: Row; orderBy?: unknown }) => sorted(rows().filter((r) => matches(r, where)), orderBy)[0] ?? null,
        findUnique: async ({ where, select }: { where: Row; select?: Row }) => {
            const found = rows().find((r) => matches(r, unique ? unique(where) : where)) ?? null;
            return found && select?.options ? { ...found, options: sorted(db.options.filter((o) => o.pollId === found.messageId), { position: "asc" }) } : found;
        },
        create: async ({ data }: { data: Row }) => {
            const key = JSON.stringify([data.messageId ?? data.pollId, data.userId]);
            if (rows().some((r) => JSON.stringify([r.messageId ?? r.pollId, r.userId]) === key)) throw Object.assign(new Error("unique"), { code: "P2002" });
            rows().push({ ...data });
            return data;
        },
        createMany: async ({ data }: { data: Row[] }) => {
            for (const row of data) if (!rows().some((r) => r.id !== undefined && r.id === row.id && r.kind === row.kind)) rows().push({ createdAt: new Date(), ...row });
            return { count: data.length };
        },
        deleteMany: async ({ where }: { where: Row }) => {
            const all = rows();
            const kept = all.filter((r) => !matches(r, where));
            const count = all.length - kept.length;
            all.splice(0, all.length, ...kept);
            return { count };
        },
        count: async ({ where }: { where: Row }) => rows().filter((r) => matches(r, where)).length
    });
    const pair = (name: string) => (where: Row) => where[name] as Row;
    const prisma = {
        chatMessage: table(() => db.messages),
        chatReaction: table(() => db.reactions),
        chatSealedReaction: table(() => db.sets, pair("messageId_userId")),
        chatPoll: table(() => db.polls),
        chatPollOption: table(() => db.options),
        chatPollVote: table(() => db.votes),
        chatPollBallot: table(() => db.ballots, pair("pollId_userId")),
        chatMigrationRollback: table(() => db.copies),
        chatHistoryKey: table(() => db.historyKeys),
        chatMigration: { findUnique: async ({ where }: { where: { channelId: string } }) => db.migration.get(where.channelId) ?? null },
        mlsGroup: { findMany: async () => [{ channelId: CHANNEL }] },
        $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(prisma)
    };
    return { Prisma: { DbNull: null }, prisma };
});
vi.mock("@/lib/chat/e2ee/flag", () => ({ chatE2eeEnabled: () => true }));
vi.mock("@/lib/chat/e2ee/sealed-conversation", () => ({ conversationSealed: async () => db.sealed }));
vi.mock("@/lib/chat/e2ee/legacy-migration", () => ({
    audienceOf: async () => [U1, U2],
    backupReady: async () => true,
    // Sealed to the members: the test keeps a copy of the key, the way a member's account key opens it.
    sealToMembers: async (channelId: string, _audience: string[], key: Uint8Array, epoch: bigint) => {
        db.sweptKeys.push({ epoch, key: new Uint8Array(key) });
        db.historyKeys.push({ channelId, epoch, recipient: U1 });
        return 1;
    }
}));

import * as content from "@polaris/chat-crypto/message-content";
import { SWEEP_EPOCH_TOP } from "@/lib/chat/e2ee/mls-history-keys";
import { restoreAnnotations } from "@/lib/chat/e2ee/annotation-rollback";
import { sealableEmoji, sweepConversation } from "@/lib/chat/e2ee/annotation-sweep";

const CHANNEL = "0192f000-0000-7000-8000-000000000001";
const M1 = "0192f000-0000-7000-8000-0000000000a1";
const POLL = "0192f000-0000-7000-8000-0000000000a2";
const OPEN_POLL = "0192f000-0000-7000-8000-0000000000a3";
const U1 = "0192f000-0000-7000-8000-0000000000b1";
const U2 = "0192f000-0000-7000-8000-0000000000b2";
const O = (n: number) => `0192f000-0000-7000-8000-0000000000c${n}`;
const R = (n: number) => `0192f000-0000-7000-8000-0000000000d${n}`;
const V = (n: number) => `0192f000-0000-7000-8000-0000000000e${n}`;

beforeEach(() => {
    db.sealed = true;
    db.migration.clear();
    for (const list of [db.messages, db.reactions, db.sets, db.polls, db.options, db.votes, db.ballots, db.copies, db.historyKeys, db.sweptKeys]) list.length = 0;
    db.messages.push({ id: M1, channelId: CHANNEL }, { id: POLL, channelId: CHANNEL }, { id: OPEN_POLL, channelId: CHANNEL });
    db.reactions.push(
        { id: R(1), messageId: M1, userId: U1, emoji: "👍", createdAt: new Date(1) },
        { id: R(2), messageId: M1, userId: U1, emoji: "🎉", createdAt: new Date(2) },
        { id: R(3), messageId: M1, userId: U2, emoji: "👍", createdAt: new Date(3) }
    );
    db.polls.push({ messageId: POLL, anonymous: true }, { messageId: OPEN_POLL, anonymous: false });
    db.options.push(
        { id: O(1), pollId: POLL, position: 0 },
        { id: O(2), pollId: POLL, position: 1 },
        { id: O(3), pollId: OPEN_POLL, position: 0 },
        { id: O(4), pollId: OPEN_POLL, position: 1 }
    );
    db.votes.push({ id: V(1), optionId: O(2), userId: U1 }, { id: V(2), optionId: O(4), userId: U2 });
});

async function openSet(row: Row): Promise<string[] | null> {
    const key = db.sweptKeys.find((k) => k.epoch === row.epoch)!.key;
    const binding = { conversationId: CHANNEL, epoch: row.epoch as bigint, messageId: row.messageId as string, setId: row.setId as string, reactor: row.userId as string };
    return content.decodeReactions(await content.openReactions(key, binding, row.sealed as Uint8Array));
}

async function openBallot(row: Row, voter: string | null): Promise<number[] | null> {
    const key = db.sweptKeys.find((k) => k.epoch === row.epoch)!.key;
    const binding = { conversationId: CHANNEL, epoch: row.epoch as bigint, pollId: row.pollId as string, ballotId: row.ballotId as string, voter };
    return content.decodeBallot(await content.openBallot(key, binding, row.sealed as Uint8Array));
}

describe("sweeping a sealed conversation's clear reactions and votes", () => {
    it("seals each person's reactions on a message as one set a reader opens, and keeps the clear rows as a rollback copy", async () => {
        await expect(sweepConversation(CHANNEL)).resolves.toBe("sealed");
        expect(db.reactions).toHaveLength(0);
        expect(db.sets).toHaveLength(2);
        const mine = db.sets.find((s) => s.userId === U1)!;
        expect(mine.epoch).toBe(SWEEP_EPOCH_TOP);
        await expect(openSet(mine)).resolves.toEqual(["👍", "🎉"]);
        await expect(openSet(db.sets.find((s) => s.userId === U2)!)).resolves.toEqual(["👍"]);
        const copies = db.copies.filter((c) => c.kind === "reaction");
        expect(copies.map((c) => c.id).sort()).toEqual([R(1), R(2), R(3)]);
        expect(JSON.parse(copies.find((c) => c.id === R(2))!.body as string)).toEqual({ userId: U1, emoji: "🎉" });
        expect(copies.every((c) => c.messageId === M1 && c.channelId === CHANNEL)).toBe(true);
    });

    it("seals each clear vote as a ballot by answer position, naming the voter only on a public poll", async () => {
        await sweepConversation(CHANNEL);
        expect(db.votes).toHaveLength(0);
        const anonymous = db.ballots.find((b) => b.pollId === POLL)!;
        const named = db.ballots.find((b) => b.pollId === OPEN_POLL)!;
        await expect(openBallot(anonymous, null)).resolves.toEqual([1]);
        await expect(openBallot(named, U2)).resolves.toEqual([1]);
        // Bound to its voter: moved to anybody else it does not open.
        await expect(openBallot(named, U1)).rejects.toThrow();
        expect(db.copies.filter((c) => c.kind === "vote").map((c) => [c.id, c.messageId])).toEqual([
            [V(1), POLL],
            [V(2), OPEN_POLL]
        ]);
    });

    it("is rerunnable: a second pass finds nothing clear and changes nothing, and a later one seals under a key of its own", async () => {
        await sweepConversation(CHANNEL);
        const before = JSON.stringify(db.sets.map((s) => s.setId));
        await expect(sweepConversation(CHANNEL)).resolves.toBe("none");
        expect(JSON.stringify(db.sets.map((s) => s.setId))).toBe(before);
        expect(db.sweptKeys).toHaveLength(1);
        // A clear reaction that turned up since (restored, say) is sealed by the next pass at the epoch below.
        db.reactions.push({ id: R(4), messageId: M1, userId: "0192f000-0000-7000-8000-0000000000b3", emoji: "🙂", createdAt: new Date(4) });
        await expect(sweepConversation(CHANNEL)).resolves.toBe("sealed");
        expect(db.sweptKeys.map((k) => k.epoch)).toEqual([SWEEP_EPOCH_TOP, SWEEP_EPOCH_TOP - 1n]);
        await expect(openSet(db.sets.find((s) => s.epoch === SWEEP_EPOCH_TOP - 1n)!)).resolves.toEqual(["🙂"]);
    });

    it("drops a clear row beside a set that already replaced it as a superseded copy, never sealing it in", async () => {
        const own = { messageId: M1, userId: U1, setId: "0192f000-0000-7000-8000-0000000000f1", epoch: 3n, sealed: new Uint8Array([7]) };
        db.sets.push(own);
        await sweepConversation(CHANNEL);
        expect(db.sets.find((s) => s.userId === U1)).toBe(own);
        expect(JSON.parse(db.copies.find((c) => c.id === R(1))!.body as string)).toEqual({ userId: U1, emoji: "👍", superseded: true });
        expect(db.reactions.filter((r) => r.userId === U1)).toHaveLength(0);
    });

    it("leaves a conversation that is not sealed, or was rolled back, exactly as it is", async () => {
        db.sealed = false;
        await expect(sweepConversation(CHANNEL)).resolves.toBe("none");
        db.sealed = true;
        db.migration.set(CHANNEL, { channelId: CHANNEL, state: "rolledBack" });
        await expect(sweepConversation(CHANNEL)).resolves.toBe("none");
        expect(db.reactions).toHaveLength(3);
        expect(db.votes).toHaveLength(2);
        expect(db.historyKeys).toHaveLength(0);
    });

    it("seals a person's emoji each once and all of them, or none when they do not fit one set", () => {
        const many = Array.from({ length: 25 }, (_, at) => `e${at}`);
        // More than the 20 a set once held, and one of 101 bytes: all carried.
        expect(sealableEmoji(["👍", "👍", "x".repeat(101), ...many])).toEqual(["👍", "x".repeat(101), ...many]);
        expect(sealableEmoji(["x".repeat(256)])).toBeNull();
        expect(sealableEmoji(Array.from({ length: 30 }, (_, at) => `${at}`.padEnd(80, "x")))).toBeNull();
        // The longest a clear reaction can be (a space's emoji token) fits 27 to a set.
        const token = (at: number) => `<a:${"n".repeat(30)}${String(at).padStart(2, "0")}:0192f000-0000-7000-8000-0000000000${String(at).padStart(2, "0")}>`;
        expect(sealableEmoji(Array.from({ length: 27 }, (_, at) => token(at)))).toHaveLength(27);
    });

    it("leaves a person whose emoji on a message do not fit one set in the clear, untouched, and seals everybody else", async () => {
        const wide = Array.from({ length: 30 }, (_, at) => `${at}`.padEnd(80, "x"));
        db.reactions.push(...wide.map((emoji, at) => ({ id: `wide-${at}`, messageId: M1, userId: U2, emoji, createdAt: new Date(10 + at) })));
        await expect(sweepConversation(CHANNEL)).resolves.toBe("kept");
        // U2's rows (the earlier one too) stay where they were and are drawn as before; nothing of theirs went to a copy that expires.
        expect(db.reactions.map((r) => r.id).sort()).toEqual([R(3), ...wide.map((_, at) => `wide-${at}`)].sort());
        expect(db.copies.filter((c) => c.kind === "reaction").map((c) => c.id).sort()).toEqual([R(1), R(2)]);
        expect(db.sets.map((s) => s.userId)).toEqual([U1]);
        // The next run finds only them and changes nothing, nor spends a sweep epoch on them.
        const epochs = new Set(db.historyKeys.map((k) => k.epoch)).size;
        await expect(sweepConversation(CHANNEL)).resolves.toBe("kept");
        expect(db.reactions).toHaveLength(31);
        expect(db.sets).toHaveLength(1);
        expect(new Set(db.historyKeys.map((k) => k.epoch)).size).toBe(epochs);
        expect(db.sweptKeys).toHaveLength(1);
    });
});

describe("rolling the sweep back", () => {
    it("puts swept reactions and votes back where the set or ballot is still the sweep's, and drops the sweep's key once none is left", async () => {
        await sweepConversation(CHANNEL);
        await expect(restoreAnnotations(CHANNEL)).resolves.toEqual({ restored: 4, kept: 0 });
        expect(db.reactions.map((r) => r.id).sort()).toEqual([R(1), R(2), R(3)]);
        expect(db.reactions.find((r) => r.id === R(2))).toMatchObject({ messageId: M1, userId: U1, emoji: "🎉" });
        expect(db.votes.map((v) => [v.id, v.optionId, v.userId])).toEqual([
            [V(1), O(2), U1],
            [V(2), O(4), U2]
        ]);
        expect(db.sets).toHaveLength(0);
        expect(db.ballots).toHaveLength(0);
        expect(db.copies).toHaveLength(0);
        expect(db.historyKeys).toHaveLength(0);
        // Repeatable: nothing left to put back.
        await expect(restoreAnnotations(CHANNEL)).resolves.toEqual({ restored: 0, kept: 0 });
    });

    it("keeps a set the person changed since, its copies and the sweep's key, and never puts a superseded row back", async () => {
        await sweepConversation(CHANNEL);
        // U1 reacted again from a browser: their set is now at the group's epoch.
        Object.assign(db.sets.find((s) => s.userId === U1)!, { epoch: 4n });
        db.copies.push({ kind: "reaction", id: R(9), messageId: M1, channelId: CHANNEL, body: JSON.stringify({ userId: U2, emoji: "🔥", superseded: true }) });
        await expect(restoreAnnotations(CHANNEL)).resolves.toEqual({ restored: 3, kept: 1 });
        expect(db.reactions.map((r) => r.id)).toEqual([R(3)]);
        expect(db.sets.map((s) => s.userId)).toEqual([U1]);
        expect(db.copies.map((c) => c.id).sort()).toEqual([R(1), R(2), R(9)]);
        // The changed set is not the sweep's, so the sweep's envelopes are no longer needed.
        expect(db.historyKeys).toHaveLength(0);
    });
});
