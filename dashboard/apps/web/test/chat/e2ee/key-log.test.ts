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
    reach: new Map<string, Set<string>>(),
    user: { id: "" } as { id: string } | null
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
        $executeRaw: async () => 0,
        $queryRaw: async (_strings: TemplateStringsArray, levels: number[], indexes: number[]) =>
            state.nodes.filter((n) => levels.some((level, i) => level === n.level && indexes[i] === n.index)),
        $transaction: async <T,>(run: (tx: unknown) => Promise<T>) => run(client)
    };
    return { prisma: client, Prisma: {} };
});

const signing = vi.hoisted(() => ({ key: null as null | { privateKey: unknown; publicKey: string } }));
vi.mock("@/lib/edge-signing-key", () => ({ storedSigningKey: () => async () => signing.key }));
vi.mock("@/lib/chat/e2ee/flag", () => ({ chatE2eeEnabled: () => true }));
vi.mock("@/lib/session", () => ({ backgroundUser: async () => state.user }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/chat/access", () => ({
    channelAccess: async (user: { id: string }, channelId: string) => state.reach.get(channelId)?.has(user.id) ?? false
}));

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
    state.reach.clear();
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

    it("answers proofs that verify under a signed head, and appends a key published before the log", async () => {
        await keyLog.appendEntry(entry(ALICE, 1));
        state.accountKeys.push({ ...entry(BOB, 2), createdAt: new Date() });
        const first = await keyLog.keyProofs([ALICE, BOB]);
        expect(first.head.treeSize).toBe(2);
        expect(first.entries.map((e) => e.userId).sort()).toEqual([ALICE, BOB].sort());
        expect(await verifies(first)).toBe(true);

        for (let i = 0; i < 5; i++) await keyLog.appendEntry(entry(`0190a1b2-0000-7000-8000-00000000010${i}`, 10 + i));
        const later = await keyLog.keyProofs([BOB], first.head.treeSize);
        expect(later.head.treeSize).toBe(7);
        expect(await verifies(later)).toBe(true);
        expect(await log.verifyConsistency(2, 7, first.head.rootHash, later.head.rootHash, later.consistency!)).toBe(true);
    });

    it("lists every entry of one account for its own browsers", async () => {
        await keyLog.appendEntry(entry(ALICE, 1));
        await keyLog.appendEntry(entry(BOB, 2));
        await keyLog.appendEntry(entry(ALICE, 3, 2));
        const own = await keyLog.ownEntries(ALICE);
        expect(own.entries.map((e) => [e.index, e.akVersion])).toEqual([[0, 1], [2, 2]]);
        expect(await verifies(own)).toBe(true);
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

    it("refuses a malformed body and a missing session", async () => {
        expect((await handleKeyLog(request({ op: "proofs", userIds: [] }))).status).toBe(400);
        expect((await handleKeyLog(request({ op: "own", extra: 1 }))).status).toBe(400);
        state.user = null;
        expect((await handleKeyLog(request({ op: "own" }))).status).toBe(401);
    });
});
