/**
 * The server's store for the MLS members it runs (Polar, service members):
 * every value sealed, a commit written all or nothing, and a restart reading
 * back exactly what the last committed operation left. The database is an
 * in-memory table whose `$transaction` applies its operations to a copy and
 * keeps the copy only if every one succeeded, as Postgres does.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    device: string;
    key: Uint8Array;
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    keyId: string;
}

type Apply = (rows: Row[]) => Row[];

/** Like a Prisma promise: lazy, run alone when awaited or inside `$transaction`. */
interface Operation extends PromiseLike<void> {
    apply: Apply;
}

const state = vi.hoisted(() => ({
    masterKey: Buffer.alloc(32, 9).toString("base64"),
    rows: [] as Row[],
    failNextInsert: false
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: state.masterKey }) }));

vi.mock("@polaris/db", () => {
    const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
    const operation = (apply: Apply): Operation => ({
        apply,
        then: (resolve, reject) =>
            Promise.resolve()
                .then(() => {
                    state.rows = apply(state.rows);
                })
                .then(resolve, reject)
    });
    const prisma = {
        $transaction: async (operations: Operation[]) => {
            let copy = state.rows.map((row) => ({ ...row }));
            for (const operation of operations) copy = operation.apply(copy);
            state.rows = copy;
        },
        mlsStoreEntry: {
            findMany: async ({ where }: { where: { device: string } }) =>
                state.rows.filter((row) => row.device === where.device).map((row) => ({ ...row })),
            deleteMany: ({ where }: { where: { device: string; key?: { in: Uint8Array[] } } }) =>
                operation((rows) =>
                    rows.filter(
                        (row) => row.device !== where.device || (where.key && !where.key.in.some((key) => same(key, row.key)))
                    )
                ),
            createMany: ({ data }: { data: Row[] }) =>
                operation((rows) => {
                    if (state.failNextInsert) {
                        state.failNextInsert = false;
                        throw new Error("connection lost");
                    }
                    for (const row of data)
                        if (rows.some((existing) => existing.device === row.device && same(existing.key, row.key)))
                            throw new Error("unique constraint");
                    return [...rows, ...data.map((row) => ({ ...row }))];
                })
        }
    };
    return { prisma };
});

const { commitMlsStore, destroyMlsStore, loadMlsStore } = await import("@/lib/chat/e2ee/mls-store");

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

async function snapshot(device: string): Promise<Record<string, string>> {
    const { keys, values } = await loadMlsStore(device);
    return Object.fromEntries(keys.map((key, i) => [text(key), text(values[i])]));
}

beforeEach(() => {
    state.rows = [];
    state.failNextInsert = false;
});

describe("server MLS store", () => {
    it("reads back what was committed, keyed by device", async () => {
        await commitMlsStore("service/polar", [
            { key: bytes("signer"), value: bytes("secret signing key") },
            { key: bytes("group/1"), value: bytes("epoch 1") }
        ]);
        await commitMlsStore("service/webhook", [{ key: bytes("signer"), value: bytes("another key") }]);
        await commitMlsStore("service/polar", [
            { key: bytes("group/1"), value: bytes("epoch 2") },
            { key: bytes("signer"), value: null }
        ]);
        expect(await snapshot("service/polar")).toEqual({ "group/1": "epoch 2" });
        expect(await snapshot("service/webhook")).toEqual({ signer: "another key" });
    });

    it("seals every value under the master key", async () => {
        await commitMlsStore("service/polar", [{ key: bytes("signer"), value: bytes("secret signing key") }]);
        const [row] = state.rows;
        expect(Buffer.from(row.ciphertext).includes(Buffer.from("secret signing key"))).toBe(false);
        expect(Buffer.from(row.ciphertext).includes(Buffer.from(Buffer.from("secret signing key").toString("base64")))).toBe(false);
        state.masterKey = Buffer.alloc(32, 10).toString("base64");
        await expect(loadMlsStore("service/polar")).rejects.toThrow();
        state.masterKey = Buffer.alloc(32, 9).toString("base64");
    });

    it("writes an operation all or nothing", async () => {
        await commitMlsStore("service/polar", [
            { key: bytes("group/1"), value: bytes("epoch 1") },
            { key: bytes("old"), value: bytes("past epoch") }
        ]);
        state.failNextInsert = true;
        await expect(
            commitMlsStore("service/polar", [
                { key: bytes("group/1"), value: bytes("epoch 2") },
                { key: bytes("old"), value: null }
            ])
        ).rejects.toThrow("connection lost");
        // The deletion that ran before the failure was rolled back with it.
        expect(await snapshot("service/polar")).toEqual({ "group/1": "epoch 1", old: "past epoch" });
    });

    it("takes the last change when a list names a key twice", async () => {
        await commitMlsStore("service/polar", [
            { key: bytes("k"), value: bytes("first") },
            { key: bytes("k"), value: bytes("second") },
            { key: bytes("gone"), value: bytes("x") },
            { key: bytes("gone"), value: null }
        ]);
        expect(await snapshot("service/polar")).toEqual({ k: "second" });
    });

    it("forgets a device and refuses a bad device id", async () => {
        await commitMlsStore("service/polar", [{ key: bytes("k"), value: bytes("v") }]);
        await destroyMlsStore("service/polar");
        expect(await snapshot("service/polar")).toEqual({});
        await expect(commitMlsStore(" ", [{ key: bytes("k"), value: bytes("v") }])).rejects.toThrow(TypeError);
        await expect(loadMlsStore("x".repeat(201))).rejects.toThrow(TypeError);
    });
});
