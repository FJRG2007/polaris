/**
 * The chat MLS delivery service and its route: 404 with the flag off; commits
 * ordered by a compare-and-set on the epoch (two devices committing at once
 * never fork the group); a one-use key package handed out once, then the
 * last-resort one; a device reads the group log and only its own Welcomes;
 * and every op refused for an account outside the conversation, for a device
 * that is not the session's, and for an account named in it from outside.
 * The tables are an in-memory stand-in with the same semantics the service
 * relies on (unique keys, `updateMany` counts, all-or-nothing transactions).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
    tables: {} as Record<string, Row[]>,
    user: { id: "11111111-1111-4111-8111-111111111111" } as { id: string } | null,
    members: new Set<string>(),
    seq: 0n
}));

vi.mock("@/lib/session", () => ({ backgroundUser: async () => state.user }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/chat/access", () => ({
    channelAccess: async (actor: { id: string }, channelId: string) => (state.members.has(`${actor.id}:${channelId}`) ? { id: channelId } : null)
}));

vi.mock("@polaris/db", () => {
    const same = (a: unknown, b: unknown) =>
        a instanceof Uint8Array && b instanceof Uint8Array ? Buffer.from(a).equals(Buffer.from(b)) : a === b;
    const matches = (row: Row, where: Row = {}): boolean =>
        Object.entries(where).every(([key, want]) => {
            if (key === "OR") return (want as Row[]).some((w) => matches(row, w));
            if (key === "userId_device") return matches(row, want as Row);
            if (want && typeof want === "object" && !(want instanceof Uint8Array)) {
                const cond = want as { in?: unknown[]; gt?: bigint; gte?: bigint; lt?: bigint };
                if (cond.in) return cond.in.includes(row[key]);
                if (cond.gt !== undefined) return (row[key] as bigint) > cond.gt;
                if (cond.gte !== undefined) return (row[key] as bigint) >= cond.gte;
                if (cond.lt !== undefined) return (row[key] as bigint) < cond.lt;
            }
            return same(row[key] ?? null, want);
        });
    const table = (name: string, keys: string[]) => {
        const rows = () => (state.tables[name] ??= []);
        const unique = (data: Row) => {
            if (keys.length && rows().some((r) => keys.every((k) => same(r[k], data[k])))) throw new Error("unique violation");
        };
        const fill = (data: Row) => ({
            ...(name === "mlsGroupEvent" ? { seq: ++state.seq, recipient: null } : {}),
            ...(name === "mlsKeyPackage" ? { id: crypto.randomUUID(), createdAt: new Date(Date.now() + rows().length) } : {}),
            ...data
        });
        return {
            findUnique: async ({ where }: { where: Row }) => rows().find((r) => matches(r, where)) ?? null,
            findFirst: async ({ where }: { where: Row }) => rows().find((r) => matches(r, where)) ?? null,
            findMany: async ({ where, take }: { where: Row; take?: number }) =>
                rows()
                    .filter((r) => matches(r, where))
                    .slice(0, take ?? Infinity),
            count: async ({ where }: { where: Row }) => rows().filter((r) => matches(r, where)).length,
            create: async ({ data }: { data: Row }) => {
                unique(data);
                rows().push(fill(data));
            },
            createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
                for (const d of data) {
                    try {
                        unique(d);
                    } catch (error) {
                        if (skipDuplicates) continue;
                        throw error;
                    }
                    rows().push(fill(d));
                }
            },
            upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
                const row = rows().find((r) => matches(r, where));
                if (row) Object.assign(row, update);
                else rows().push(fill(create));
            },
            updateMany: async ({ where, data }: { where: Row; data: Row }) => {
                const hit = rows().filter((r) => matches(r, where));
                for (const r of hit) Object.assign(r, data);
                return { count: hit.length };
            },
            deleteMany: async ({ where }: { where: Row }) => {
                const before = rows().length;
                state.tables[name] = rows().filter((r) => !matches(r, where));
                return { count: before - state.tables[name].length };
            }
        };
    };
    let queue: Promise<unknown> = Promise.resolve();
    const prisma = {
        mlsDevice: table("mlsDevice", ["userId", "device"]),
        mlsKeyPackage: table("mlsKeyPackage", []),
        mlsGroup: table("mlsGroup", ["channelId"]),
        mlsGroupEvent: table("mlsGroupEvent", []),
        chatHistoryKey: table("chatHistoryKey", ["channelId", "epoch", "recipient"]),
        // All or nothing, one at a time (Postgres's row lock on the group does
        // the same for two commits): run on the live tables, put the copy back
        // on a throw.
        $transaction: (fn: (tx: unknown) => Promise<unknown>) => {
            const run = queue.then(async () => {
                const snapshot = structuredClone(state.tables);
                try {
                    return await fn(prisma);
                } catch (error) {
                    state.tables = snapshot;
                    throw error;
                }
            });
            queue = run.catch(() => undefined);
            return run;
        }
    };
    return { prisma };
});

const { handleMls } = await import("@/lib/chat/e2ee/mls-handler");

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const EVE = "33333333-3333-4333-8333-333333333333";
const CHANNEL = "44444444-4444-4444-8444-444444444444";
const blob = (fill: number, length = 40) => Buffer.alloc(length, fill).toString("base64url");

async function call(body: unknown, as: string | null = ALICE) {
    state.user = as ? { id: as } : null;
    const response = await handleMls(new Request("http://x/api/e2ee/mls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function device(userId: string, name: string) {
    expect((await call({ op: "register-device", device: name, signatureKey: blob(7, 32), e2eeVersion: 1 }, userId)).status).toBe(200);
}

beforeEach(() => {
    process.env.POLARIS_INTERNAL_CHAT_E2EE = "1";
    state.tables = {};
    state.seq = 0n;
    state.members = new Set([`${ALICE}:${CHANNEL}`, `${BOB}:${CHANNEL}`]);
});

describe("/api/e2ee/mls", () => {
    it("does not exist with the flag off, and needs a session and JSON", async () => {
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "0";
        expect((await call({ op: "group", channelId: CHANNEL })).status).toBe(404);
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "1";
        expect((await call({ op: "group", channelId: CHANNEL }, null)).status).toBe(401);
        expect((await call({ op: "group", channelId: "not-a-uuid" })).status).toBe(400);
        const plain = await handleMls(new Request("http://x", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }));
        expect(plain.status).toBe(400);
    });

    it("orders commits by epoch: the second commit for the same epoch is refused, not forked", async () => {
        await device(ALICE, "alice-laptop");
        await device(BOB, "bob-phone-1");
        expect((await call({ op: "create-group", channelId: CHANNEL, groupId: blob(1, 16), ciphersuite: 0x004f, groupInfo: blob(2) })).status).toBe(200);
        expect((await call({ op: "create-group", channelId: CHANNEL, groupId: blob(3, 16), ciphersuite: 0x004f, groupInfo: blob(2) })).body.error).toBe("groupExists");
        const commit = (as: string, name: string, payload: number) =>
            call({ op: "commit", channelId: CHANNEL, device: name, epoch: "0", commit: blob(payload), groupInfo: blob(payload + 1) }, as);
        const [first, second] = await Promise.all([commit(ALICE, "alice-laptop", 10), commit(BOB, "bob-phone-1", 20)]);
        expect([first.status, second.status].sort()).toEqual([200, 409]);
        expect([first.body.error, second.body.error]).toContain("staleEpoch");
        const group = (await call({ op: "group", channelId: CHANNEL })).body.group as { epoch: string };
        expect(group.epoch).toBe("1");
        expect(state.tables.mlsGroupEvent.filter((e) => e.kind === "commit")).toHaveLength(1);
    });

    it("hands a one-use key package out once, then the last-resort one", async () => {
        await device(BOB, "bob-phone-1");
        const publish = (keyPackages: string[], lastResort: boolean) =>
            call({ op: "publish-key-packages", device: "bob-phone-1", ciphersuite: 0x004f, keyPackages, lastResort }, BOB);
        expect((await publish([blob(5)], false)).status).toBe(200);
        expect((await publish([blob(6)], true)).status).toBe(200);
        const held = await call({ op: "register-device", device: "bob-phone-1", signatureKey: blob(7, 32), e2eeVersion: 1, ciphersuite: 0x004f }, BOB);
        expect(held.body.heldKeyPackages).toBe(1);
        const claim = () => call({ op: "claim-key-packages", channelId: CHANNEL, userIds: [BOB], ciphersuite: 0x004f });
        const [one, two, three] = [await claim(), await claim(), await claim()];
        const first = (r: { body: Record<string, unknown> }) => (r.body.keyPackages as { keyPackage: string; address: string }[])[0];
        expect(first(one)).toEqual({ address: `${BOB}/bob-phone-1`, keyPackage: blob(5) });
        expect(first(two).keyPackage).toBe(blob(6));
        expect(first(three).keyPackage).toBe(blob(6));
        expect((await call({ op: "publish-key-packages", device: "not-registered", ciphersuite: 0x004f, keyPackages: [blob(5)] }, BOB)).status).toBe(409);
        expect((await publish(Array.from({ length: 100 }, () => blob(9)), false)).status).toBe(200);
        expect((await publish([blob(9)], false)).body.error).toBe("tooManyKeyPackages");
    });

    it("keeps the last 256 epochs of a group's log and the GroupInfo to rejoin from", async () => {
        await device(ALICE, "alice-laptop");
        await call({ op: "create-group", channelId: CHANNEL, groupId: blob(1, 16), ciphersuite: 0x004f, groupInfo: blob(2) });
        for (let epoch = 0; epoch < 320; epoch++) {
            const moved = await call({ op: "commit", channelId: CHANNEL, device: "alice-laptop", epoch: String(epoch), commit: blob(10), groupInfo: blob(11) });
            expect(moved.status).toBe(200);
        }
        const epochs = state.tables.mlsGroupEvent.map((e) => e.epoch as bigint);
        // The group is at epoch 320, a multiple of 32: everything before 320 - 256 is gone.
        expect(epochs.reduce((a, b) => (a < b ? a : b))).toBe(64n);
        expect(epochs).toHaveLength(256);
        expect(((await call({ op: "group", channelId: CHANNEL })).body.group as { epoch: string; groupInfo: string }).groupInfo).toBe(blob(11));
    });

    it("gives a device the group log and only its own Welcomes", async () => {
        await device(ALICE, "alice-laptop");
        await device(BOB, "bob-phone-1");
        await call({ op: "create-group", channelId: CHANNEL, groupId: blob(1, 16), ciphersuite: 0x004f, groupInfo: blob(2) });
        const welcomes = [{ recipient: `${BOB}/bob-phone-1`, welcome: blob(30) }];
        expect((await call({ op: "commit", channelId: CHANNEL, device: "alice-laptop", epoch: "0", commit: blob(10), groupInfo: blob(11), welcomes })).status).toBe(200);
        await call({ op: "application", channelId: CHANNEL, device: "alice-laptop", epoch: "1", payload: blob(40) });
        const read = async (as: string, name: string) =>
            ((await call({ op: "events", channelId: CHANNEL, device: name }, as)).body.events as { kind: string }[]).map((e) => e.kind);
        expect(await read(BOB, "bob-phone-1")).toEqual(["commit", "welcome", "application"]);
        expect(await read(ALICE, "alice-laptop")).toEqual(["commit", "application"]);
        expect((await call({ op: "application", channelId: CHANNEL, device: "alice-laptop", epoch: "9", payload: blob(40) })).body.error).toBe("staleEpoch");
    });

    it("refuses accounts outside the conversation, devices that are not the session's, and outsiders named in an op", async () => {
        await device(ALICE, "alice-laptop");
        await device(EVE, "eve-laptop-1");
        await call({ op: "create-group", channelId: CHANNEL, groupId: blob(1, 16), ciphersuite: 0x004f, groupInfo: blob(2) });
        expect((await call({ op: "group", channelId: CHANNEL }, EVE)).status).toBe(403);
        expect((await call({ op: "events", channelId: CHANNEL, device: "eve-laptop-1" }, EVE)).status).toBe(403);
        // Bob's session cannot use Alice's device.
        expect((await call({ op: "events", channelId: CHANNEL, device: "alice-laptop" }, BOB)).status).toBe(403);
        expect((await call({ op: "claim-key-packages", channelId: CHANNEL, userIds: [EVE], ciphersuite: 0x004f })).status).toBe(403);
        const welcomes = [{ recipient: `${EVE}/eve-laptop-1`, welcome: blob(30) }];
        expect((await call({ op: "commit", channelId: CHANNEL, device: "alice-laptop", epoch: "0", commit: blob(10), groupInfo: blob(11), welcomes })).status).toBe(403);
        expect((await call({ op: "put-history-keys", channelId: CHANNEL, epoch: "1", envelopes: [{ recipient: EVE, envelope: blob(8, 100) }] })).status).toBe(403);
        expect(state.tables.mlsGroupEvent ?? []).toHaveLength(0);
    });

    it("stores history-key envelopes once and serves each account only its own", async () => {
        const envelopes = [
            { recipient: ALICE, envelope: blob(1, 100) },
            { recipient: BOB, envelope: blob(2, 100) },
            { recipient: "org", envelope: blob(3, 100) }
        ];
        expect((await call({ op: "put-history-keys", channelId: CHANNEL, epoch: "1", envelopes })).status).toBe(200);
        await call({ op: "put-history-keys", channelId: CHANNEL, epoch: "1", envelopes: [{ recipient: BOB, envelope: blob(9, 100) }] });
        const mine = (await call({ op: "history-keys", channelId: CHANNEL }, BOB)).body.historyKeys;
        expect(mine).toEqual([{ epoch: "1", envelope: blob(2, 100) }]);
    });
});
