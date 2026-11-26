/**
 * The account key log's server half and route: appends take the next index
 * and store the subtrees they complete, keys published before the log are
 * appended on first ask, every answer verifies with the package's RFC 9162
 * checks under a valid signed head, and the route names only accounts the
 * caller may learn about.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, createPublicKey } from "node:crypto";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
    entries: [] as Row[],
    nodes: [] as Row[],
    accountKeys: [] as Row[],
    handovers: [] as Row[],
    reach: new Map<string, Set<string>>(),
    peers: new Set<string>(),
    user: { id: "" } as { id: string } | null,
    busy: 0
}));

vi.mock("@polaris/db", () => {
    const sameBytes = (a: unknown, b: unknown) => a === b;
    const where = (row: Row, w: Row = {}) =>
        Object.entries(w).every(([key, want]) => {
            if (key === "userId_akVersion") return Object.entries(want as Row).every(([k, v]) => sameBytes(row[k], v));
            if (want && typeof want === "object" && "in" in (want as Row)) return ((want as { in: unknown[] }).in).includes(row[key]);
            return row[key] === want;
        });
    const sorted = (rows: Row[], orderBy?: Record<string, "asc" | "desc">) => {
        if (!orderBy) return rows;
        const [[field, dir]] = Object.entries(orderBy) as [[string, "asc" | "desc"]];
        return [...rows].sort((a, b) => ((a[field] as number) - (b[field] as number)) * (dir === "asc" ? 1 : -1));
    };
    const entryTable = {
        findFirst: async ({ orderBy }: { orderBy?: Record<string, "asc" | "desc"> }) => sorted(state.entries, orderBy)[0] ?? null,
        findUnique: async ({ where: w }: { where: Row }) => state.entries.find((r) => where(r, w)) ?? null,
        findMany: async ({ where: w, orderBy, take, distinct }: { where: Row; orderBy?: Record<string, "asc" | "desc">; take?: number; distinct?: string[] }) => {
            let rows = sorted(state.entries.filter((r) => where(r, w)), orderBy);
            if (distinct) {
                const seen = new Set<unknown>();
                rows = rows.filter((r) => (seen.has(r[distinct[0]!]) ? false : (seen.add(r[distinct[0]!]), true)));
            }
            return rows.slice(0, take ?? Infinity);
        },
        create: async ({ data }: { data: Row }) => {
            if (state.entries.some((r) => r.index === data.index || (r.userId === data.userId && r.akVersion === data.akVersion))) throw new Error("unique violation");
            state.entries.push(data);
            return data;
        }
    };
    const client = {
        chatKeyLogEntry: entryTable,
        chatKeyLogNode: {
            createMany: async ({ data }: { data: Row[] }) => {
                for (const row of data) {
                    if (state.nodes.some((n) => n.level === row.level && n.index === row.index)) throw new Error("unique violation");
                    state.nodes.push(row);
                }
                return { count: data.length };
            }
        },
        chatAccountKey: { findMany: async ({ where: w }: { where: Row }) => state.accountKeys.filter((r) => where(r, w)) },
        // Insertion order is id order, as UUIDv7 ids are.
        chatKeyLogHandover: {
            findFirst: async () => state.handovers.at(-1) ?? null,
            findUnique: async ({ where: w }: { where: { toKey: Buffer } }) => state.handovers.find((r) => Buffer.compare(r.toKey as Buffer, w.toKey) === 0) ?? null,
            findMany: async ({ take }: { take?: number }) => [...state.handovers].reverse().slice(0, take ?? Infinity),
            create: async ({ data }: { data: Row }) => {
                if (state.handovers.some((r) => Buffer.compare(r.toKey as Buffer, data.toKey as Buffer) === 0)) throw new Error("unique violation");
                const row = { id: `h${state.handovers.length}`, ...data };
                state.handovers.push(row);
                return row;
            },
            createMany: async ({ data }: { data: Row[] }) => {
                let count = 0;
                for (const row of data) {
                    if (state.handovers.some((r) => Buffer.compare(r.toKey as Buffer, row.toKey as Buffer) === 0)) continue;
                    state.handovers.push({ id: `h${state.handovers.length}`, ...row });
                    count++;
                }
                return { count };
            },
            deleteMany: async ({ where: w }: { where: { id: string } }) => {
                const before = state.handovers.length;
                state.handovers = state.handovers.filter((r) => r.id !== w.id);
                return { count: before - state.handovers.length };
            }
        },
        $executeRaw: async () => 0,
        $queryRaw: async (strings: TemplateStringsArray, levels: number[], indexes: number[]) => {
            if (strings.join("").includes("pg_try_advisory_xact_lock")) return [{ locked: state.busy-- <= 0 }];
            return state.nodes.filter((n) => levels.some((level, i) => level === n.level && indexes[i] === n.index));
        },
        $transaction: async <T,>(run: (tx: unknown) => Promise<T>) => run(client)
    };
    return { prisma: client, Prisma: {} };
});

const signing = vi.hoisted(() => ({ key: null as null | { privateKey: unknown; publicKey: string } }));
vi.mock("@/lib/edge-signing-key", () => ({
    storedSigningKey: () =>
        Object.assign(async () => signing.key, {
            forget: () => undefined,
            async rotate(handOver: (previous: unknown, next: string) => Promise<() => Promise<void>>) {
                const next = await freshKey();
                await handOver(signing.key, next.publicKey);
                signing.key = next;
                return next;
            }
        })
}));

/** An Ed25519 pair as the stored signing key holds it. */
async function freshKey(): Promise<{ privateKey: unknown; publicKey: string }> {
    const { generateKeyPairSync: generate, createPublicKey: publicOf } = await import("node:crypto");
    const { privateKey } = generate("ed25519");
    return { privateKey, publicKey: (publicOf(privateKey).export({ format: "jwk" }) as { x: string }).x };
}
vi.mock("@/lib/chat/e2ee/flag", () => ({ chatE2eeEnabled: () => true }));
vi.mock("@/lib/session", () => ({ backgroundUser: async () => state.user }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/chat/access", () => ({
    channelAccess: async (user: { id: string }, channelId: string) => state.reach.get(channelId)?.has(user.id) ?? false
}));
vi.mock("@/lib/chat/e2ee/recovery-service", () => ({ recoveryPeers: async () => new Set(state.peers) }));

import * as keyLog from "@/lib/chat/e2ee/key-log";
import * as log from "@polaris/chat-crypto/key-log";
import { handleKeyLog } from "@/lib/chat/e2ee/key-log-handler";

const ALICE = "0190a1b2-0000-7000-8000-00000000000a";
const BOB = "0190a1b2-0000-7000-8000-00000000000b";
const CAROL = "0190a1b2-0000-7000-8000-00000000000c";
const CHANNEL = "0190a1b2-0000-7000-8000-0000000000c1";

const entry = (userId: string, seed: number, akVersion = 1) => ({
    userId,
    akVersion,
    signPublicKey: new Uint8Array(32).fill(seed),
    hpkePublicKey: new Uint8Array(1216).fill(seed + 1)
});

async function verifies(answer: keyLog.LogAnswer): Promise<boolean> {
    if (!(await log.verifyHead(answer.head, answer.logKey))) return false;
    for (const e of answer.entries) {
        if (!(await log.verifyInclusion(e.index, answer.head.treeSize, await log.entryLeafHash(e), e.proof, answer.head.rootHash))) return false;
    }
    return true;
}

function request(body: unknown): Request {
    return new Request("http://polaris.test/api/e2ee/key-log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
    });
}

beforeEach(() => {
    state.entries.length = 0;
    state.nodes.length = 0;
    state.accountKeys.length = 0;
    state.handovers = [];
    state.reach.clear();
    state.peers.clear();
    state.busy = 0;
    state.user = { id: ALICE };
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x: string };
    signing.key = { privateKey, publicKey: jwk.x };
});

describe("key log server", () => {
    it("appends each (account, version) once, at the next index", async () => {
        expect(await keyLog.appendEntry(entry(ALICE, 1))).toBe(true);
        expect(await keyLog.appendEntry(entry(BOB, 2))).toBe(true);
        expect(await keyLog.appendEntry(entry(ALICE, 9))).toBe(false);
        expect(state.entries.map((r) => [r.index, r.userId])).toEqual([[0, ALICE], [1, BOB]]);
        // Two leaves and the subtree over both.
        expect(state.nodes.map((n) => `${n.level}:${n.index}`).sort()).toEqual(["0:0", "0:1", "1:0"]);
    });

    it("retries a busy lock instead of waiting on it, and gives up after a bounded number of tries", async () => {
        state.busy = 2;
        expect(await keyLog.appendEntry(entry(ALICE, 1))).toBe(true);
        expect(state.entries).toHaveLength(1);
        state.busy = 100;
        await expect(keyLog.appendEntry(entry(BOB, 2))).rejects.toThrow("busy");
        expect(state.entries).toHaveLength(1);
    });

    it("answers proofs that verify under a signed head, and appends a key published before the log", async () => {
        await keyLog.appendEntry(entry(ALICE, 1));
        state.accountKeys.push({ ...entry(BOB, 2), createdAt: new Date() });
        const first = await keyLog.keyProofs([ALICE, BOB]);
        expect(first.head.treeSize).toBe(2);
        expect(first.entries.map((e) => e.userId).sort()).toEqual([ALICE, BOB].sort());
        expect(await verifies(first)).toBe(true);

        for (let i = 0; i < 5; i++) await keyLog.appendEntry(entry(`0190a1b2-0000-7000-8000-00000000010${i}`, 10 + i));
        const later = await keyLog.keyProofs([BOB], { since: first.head.treeSize });
        expect(later.head.treeSize).toBe(7);
        expect(await verifies(later)).toBe(true);
        expect(await log.verifyConsistency(2, 7, first.head.rootHash, later.head.rootHash, later.consistency!)).toBe(true);
    });

    it("lists every entry of one account for its own browsers", async () => {
        await keyLog.appendEntry(entry(ALICE, 1));
        await keyLog.appendEntry(entry(BOB, 2));
        await keyLog.appendEntry(entry(ALICE, 3, 2));
        const own = await keyLog.ownEntries(ALICE);
        expect(own.entries.map((e) => [e.index, e.akVersion])).toEqual([[2, 2], [0, 1]]);
        expect(await verifies(own)).toBe(true);
    });
});

describe("key log key changes", () => {
    /** Whether every hand-over of `answer` holds and its head is a prefix of the answer's head. */
    async function chainHolds(answer: keyLog.LogAnswer, pinned: Uint8Array): Promise<string> {
        const followed = await log.followHandovers(pinned, answer.logKey, answer.handovers);
        for (const link of answer.handovers) {
            const prefix = await log.verifyConsistency(link.head.treeSize, answer.head.treeSize, link.head.rootHash, answer.head.rootHash, link.consistency);
            if (!prefix) return "fork";
        }
        return followed.kind;
    }

    it("records the first key once and answers no hand-over to a browser on it", async () => {
        await keyLog.appendEntry(entry(ALICE, 1));
        const first = await keyLog.keyProofs([ALICE]);
        const again = await keyLog.keyProofs([ALICE], { since: 1, logKey: first.logKey });
        expect(state.handovers).toHaveLength(1);
        expect(state.handovers[0]!.fromKey).toBeNull();
        expect(again.handovers).toEqual([]);
    });

    it("hands over to a new key with the old key's signature, which a pinned browser follows", async () => {
        await keyLog.appendEntry(entry(ALICE, 1));
        const before = await keyLog.keyProofs([ALICE]);
        await keyLog.appendEntry(entry(BOB, 2));
        await keyLog.rotateLogKey();
        await keyLog.appendEntry(entry(CAROL, 3));
        const after = await keyLog.keyProofs([ALICE], { since: before.head.treeSize, logKey: before.logKey });
        expect(Buffer.from(after.logKey).equals(Buffer.from(before.logKey))).toBe(false);
        expect(await verifies(after)).toBe(true);
        expect(after.handovers).toHaveLength(1);
        expect(after.handovers[0]!.head.treeSize).toBe(2);
        expect(await chainHolds(after, before.logKey)).toBe("linked");
        // Without the key it pinned, a browser is handed no chain to follow.
        expect((await keyLog.keyProofs([ALICE])).handovers).toEqual([]);
    });

    it("records a key that replaced an unreadable one as an unsigned reset, never as a hand-over", async () => {
        await keyLog.appendEntry(entry(ALICE, 1));
        const before = await keyLog.keyProofs([ALICE]);
        // What `storedSigningKey` does when the master key no longer opens the stored key.
        signing.key = await freshKey();
        const after = await keyLog.keyProofs([ALICE], { since: 1, logKey: before.logKey });
        expect(after.handovers).toHaveLength(1);
        expect(after.handovers[0]!.signature).toBeNull();
        expect(await chainHolds(after, before.logKey)).toBe("reset");
    });

    it("answers no chain from a key it never signed with", async () => {
        await keyLog.appendEntry(entry(ALICE, 1));
        await keyLog.keyProofs([ALICE]);
        await keyLog.rotateLogKey();
        const stranger = new Uint8Array(32).fill(5);
        const answer = await keyLog.keyProofs([ALICE], { since: 1, logKey: stranger });
        expect(answer.handovers).toEqual([]);
        expect(await chainHolds(answer, stranger)).toBe("broken");
    });
});

describe("key log route", () => {
    it("answers only the caller's own account without a conversation", async () => {
        await keyLog.appendEntry(entry(ALICE, 1));
        await keyLog.appendEntry(entry(BOB, 2));
        const response = await handleKeyLog(request({ op: "proofs", userIds: [ALICE, BOB] }));
        expect(response.status).toBe(200);
        const body = (await response.json()) as { entries: { userId: string }[]; head: { treeSize: number } };
        expect(body.entries.map((e) => e.userId)).toEqual([ALICE]);
        expect(body.head.treeSize).toBe(2);
    });

    it("leaves out accounts outside the conversation, and everybody when the caller is outside it", async () => {
        await keyLog.appendEntry(entry(BOB, 2));
        await keyLog.appendEntry(entry(CAROL, 3));
        state.reach.set(CHANNEL, new Set([ALICE, BOB]));
        const inside = (await (await handleKeyLog(request({ op: "proofs", channelId: CHANNEL, userIds: [BOB, CAROL] }))).json()) as { entries: { userId: string }[] };
        expect(inside.entries.map((e) => e.userId)).toEqual([BOB]);
        state.user = { id: CAROL };
        const outside = (await (await handleKeyLog(request({ op: "proofs", channelId: CHANNEL, userIds: [BOB] }))).json()) as { entries: unknown[] };
        expect(outside.entries).toEqual([]);
    });

    it("answers the recovery scope only for the caller's recovery peers, with proofs under the signed head", async () => {
        await keyLog.appendEntry(entry(BOB, 2));
        await keyLog.appendEntry(entry(CAROL, 3));
        state.peers.add(BOB);
        const response = await handleKeyLog(request({ op: "proofs", recovery: true, userIds: [BOB, CAROL] }));
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            entries: { userId: string; index: number; proof: string[] }[];
            head: { treeSize: number };
        };
        expect(body.entries.map((e) => e.userId)).toEqual([BOB]);
        expect(body.head.treeSize).toBe(2);
        state.peers.clear();
        const none = (await (await handleKeyLog(request({ op: "proofs", recovery: true, userIds: [BOB] }))).json()) as { entries: unknown[] };
        expect(none.entries).toEqual([]);
    });

    it("refuses a malformed body and a missing session", async () => {
        expect((await handleKeyLog(request({ op: "proofs", userIds: [] }))).status).toBe(400);
        expect((await handleKeyLog(request({ op: "proofs", recovery: true, channelId: CHANNEL, userIds: [BOB] }))).status).toBe(400);
        expect((await handleKeyLog(request({ op: "proofs", recovery: false, userIds: [BOB] }))).status).toBe(400);
        expect((await handleKeyLog(request({ op: "own", extra: 1 }))).status).toBe(400);
        state.user = null;
        expect((await handleKeyLog(request({ op: "own" }))).status).toBe(401);
    });
});
