/**
 * The phone numbers on an account: several per account, one primary, a
 * confirmed number belongs to one account only. A code goes to a number
 * whichever account holds it, and entering it moves the number to whoever did -
 * the recycled-number rule - unless the holder may not lose it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    userId: string;
    phone: string;
    primary: boolean;
    verifiedAt: Date | null;
    codeHash: string | null;
    codeExpiresAt: Date | null;
    attempts: number;
    createdAt: Date;
}

let rows: Row[] = [];
let seq = 0;

type Where = Record<string, unknown>;

function matches(row: Row, where: Where = {}): boolean {
    return Object.entries(where).every(([key, want]) => {
        const value = (row as unknown as Record<string, unknown>)[key];
        if (want && typeof want === "object" && !(want instanceof Date)) {
            const cond = want as { not?: unknown; in?: unknown[] };
            if ("not" in cond) return cond.not === null ? value !== null : value !== cond.not;
            if ("in" in cond) return cond.in!.includes(value);
        }
        return value === want;
    });
}

function ordered(list: Row[]): Row[] {
    return [...list].sort(
        (a, b) => Number(b.primary) - Number(a.primary) || a.createdAt.getTime() - b.createdAt.getTime()
    );
}

function apply(row: Row, data: Record<string, unknown>) {
    const target = row as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === "object" && "increment" in value) {
            target[key] = (target[key] as number) + (value as { increment: number }).increment;
        } else target[key] = value;
    }
}

const userPhone = {
    findFirst: async ({ where }: { where?: Where }) => ordered(rows.filter((row) => matches(row, where)))[0] ?? null,
    findMany: async ({ where }: { where?: Where }) => ordered(rows.filter((row) => matches(row, where))),
    count: async ({ where }: { where?: Where }) => rows.filter((row) => matches(row, where)).length,
    create: async ({ data }: { data: { userId: string; phone: string; primary: boolean } }) => {
        const clash = rows.some(
            (row) => row.userId === data.userId && (row.phone === data.phone || (data.primary && row.primary))
        );
        if (clash) throw Object.assign(new Error("unique"), { code: "P2002" });
        seq += 1;
        const row: Row = {
            id: `phone-${seq}`,
            verifiedAt: null,
            codeHash: null,
            codeExpiresAt: null,
            attempts: 0,
            createdAt: new Date(Date.now() + seq),
            ...data
        };
        rows.push(row);
        return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((one) => one.id === where.id)!;
        apply(row, data);
        return row;
    },
    updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        for (const row of rows.filter((one) => matches(one, where))) apply(row, data);
    },
    deleteMany: async ({ where }: { where: Where }) => {
        rows = rows.filter((row) => !matches(row, where));
    }
};

const prisma = {
    userPhone,
    $transaction: async (work: unknown) =>
        typeof work === "function"
            ? (work as (tx: unknown) => Promise<unknown>)({ userPhone, $executeRaw: async () => 0 })
            : Promise.all(work as Promise<unknown>[])
};

vi.mock("@polaris/db", () => ({ prisma }));
vi.mock("../../src/security.js", () => ({
    verifyAccountPassword: async (_auth: unknown, _user: string, given: string) => given === "pw",
    hashSecret: async (_auth: unknown, code: string) => `hash:${code}`,
    verifySecret: async (_auth: unknown, hash: string, code: string) => hash === `hash:${code}`
}));

const {
    addUserPhone,
    getUserPhone,
    issuePhoneCode,
    listUserPhones,
    PHONE_KEPT_ELSEWHERE,
    promoteUserPhone,
    removeUserPhone,
    verifyPhoneCode
} = await import("../../src/phone.js");
const auth = {} as never;

// Fixture numbers only (Spain's 600 mobile range).
const A = "+34600111222";
const B = "+34600111333";

async function confirmed(userId: string, phone: string): Promise<string> {
    const { id } = await addUserPhone(auth, userId, phone, "pw");
    const { code } = await issuePhoneCode(auth, userId, id);
    expect(await verifyPhoneCode(auth, userId, code!, id)).toEqual({});
    return id!;
}

beforeEach(() => {
    rows = [];
    seq = 0;
});

describe("adding numbers", () => {
    it("asks for the password, makes the first the primary and the next ones not", async () => {
        expect(await addUserPhone(auth, "u1", A, "nope")).toEqual({ error: "Current password is incorrect." });
        await addUserPhone(auth, "u1", A, "pw");
        await addUserPhone(auth, "u1", B, "pw");
        expect((await listUserPhones("u1")).map((row) => [row.phone, row.primary])).toEqual([
            [A, true],
            [B, false]
        ]);
    });

    it("refuses the same number twice on one account and more than five", async () => {
        await addUserPhone(auth, "u1", A, "pw");
        expect(await addUserPhone(auth, "u1", A, "pw")).toEqual({ error: "That number is already on your account." });
        for (let n = 0; n < 4; n++) await addUserPhone(auth, "u1", `+3460011100${n}`, "pw");
        expect((await addUserPhone(auth, "u1", B, "pw")).error).toMatch(/at most 5/);
    });
});

describe("a number another account has confirmed", () => {
    it("gets a code like any other, and entering it moves the number off the other account", async () => {
        await confirmed("owner", A);
        await confirmed("owner", B);
        const added = await addUserPhone(auth, "new", A, "pw");
        expect(added.error).toBeUndefined();
        const issued = await issuePhoneCode(auth, "new", added.id);
        expect(issued).toEqual({ code: expect.stringMatching(/^\d{6}$/), phone: A });
        expect(await verifyPhoneCode(auth, "new", issued.code!, added.id)).toEqual({ takenFrom: ["owner"] });
        expect(await listUserPhones("new")).toMatchObject([{ phone: A, verified: true, primary: true }]);
        // The old account keeps its other number, which is now its primary.
        expect(await listUserPhones("owner")).toMatchObject([{ phone: B, verified: true, primary: true }]);
    });

    it("stays where it is when the holder may not lose it, and the code is spent", async () => {
        await confirmed("owner", A);
        const added = await addUserPhone(auth, "new", A, "pw");
        const { code } = await issuePhoneCode(auth, "new", added.id);
        const refused = await verifyPhoneCode(auth, "new", code!, added.id, { mayTakeFrom: async () => false });
        expect(refused).toEqual({ error: PHONE_KEPT_ELSEWHERE, keptBy: ["owner"] });
        expect(await listUserPhones("owner")).toMatchObject([{ phone: A, verified: true }]);
        expect(await verifyPhoneCode(auth, "new", code!, added.id)).toEqual({ error: "Ask for a code first." });
    });

    it("gives nothing away before the code is entered", async () => {
        await confirmed("owner", A);
        const held = await addUserPhone(auth, "new", A, "pw");
        const free = await addUserPhone(auth, "new", B, "pw");
        const [one, two] = [await issuePhoneCode(auth, "new", held.id), await issuePhoneCode(auth, "new", free.id)];
        expect(Object.keys(one).sort()).toEqual(Object.keys(two).sort());
        expect(await verifyPhoneCode(auth, "new", "000000", held.id)).toEqual({ error: "That code is not right." });
    });

    it("lets either side of a pair confirmed on both accounts claim it again", async () => {
        const mine = await confirmed("u1", A);
        await confirmed("u2", B);
        // The state an install has from before a number was one account's only.
        rows.find((row) => row.userId === "u2")!.phone = A;
        expect(await listUserPhones("u1")).toMatchObject([{ phone: A, verified: true, reconfirm: true }]);
        const { code } = await issuePhoneCode(auth, "u1", mine);
        expect(await verifyPhoneCode(auth, "u1", code!, mine)).toEqual({ takenFrom: ["u2"] });
        expect(await listUserPhones("u1")).toMatchObject([{ phone: A, verified: true, reconfirm: false }]);
        expect(await listUserPhones("u2")).toEqual([]);
        expect(await issuePhoneCode(auth, "u1", mine)).toEqual({ error: "That number is already confirmed." });
    });
});

describe("the primary", () => {
    it("moves to the first confirmed number when the primary is unconfirmed", async () => {
        await addUserPhone(auth, "u1", A, "pw");
        const second = await confirmed("u1", B);
        expect((await getUserPhone("u1"))?.id).toBe(second);
        expect(rows.filter((row) => row.primary)).toHaveLength(1);
    });

    it("can only be a confirmed number", async () => {
        await confirmed("u1", A);
        const { id } = await addUserPhone(auth, "u1", B, "pw");
        expect(await promoteUserPhone("u1", id!)).toEqual({ error: "Confirm the number before making it primary." });
        const { code } = await issuePhoneCode(auth, "u1", id);
        await verifyPhoneCode(auth, "u1", code!, id);
        expect(await promoteUserPhone("u1", id!)).toEqual({});
        expect((await getUserPhone("u1"))?.phone).toBe(B);
        expect(rows.filter((row) => row.primary)).toHaveLength(1);
    });

    it("passes to another confirmed number when the primary is removed", async () => {
        const first = await confirmed("u1", A);
        await confirmed("u1", B);
        expect(await removeUserPhone(auth, "u1", "pw", { phoneId: first })).toEqual({});
        expect(await getUserPhone("u1")).toMatchObject({ phone: B, primary: true });
    });

    it("is what a caller without an id acts on", async () => {
        await addUserPhone(auth, "u1", A, "pw");
        await addUserPhone(auth, "u1", B, "pw");
        expect((await issuePhoneCode(auth, "u1")).phone).toBe(A);
    });
});

describe("removing", () => {
    it("keeps the last confirmed number when the instance requires one", async () => {
        const only = await confirmed("u1", A);
        const { id: spare } = await addUserPhone(auth, "u1", B, "pw");
        const refused = await removeUserPhone(auth, "u1", "pw", { phoneId: only, keepOneConfirmed: true });
        expect(refused.error).toMatch(/requires a confirmed number/);
        expect(await removeUserPhone(auth, "u1", "pw", { phoneId: spare, keepOneConfirmed: true })).toEqual({});
        expect(await removeUserPhone(auth, "u1", "pw", { phoneId: only })).toEqual({});
        expect(await listUserPhones("u1")).toEqual([]);
    });

    it("does not touch another account's number", async () => {
        const theirs = await confirmed("owner", A);
        expect(await removeUserPhone(auth, "u1", "pw", { phoneId: theirs })).toEqual({
            error: "That number is not on your account."
        });
        expect(rows).toHaveLength(1);
    });
});
