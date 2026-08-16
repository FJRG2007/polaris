/**
 * Naming the account that takes over this one.
 *
 * The lookup is the part worth pinning down: a username or an address is unique
 * and answers on its own, a name is not and must refuse rather than guess, and
 * nobody may name themselves - a successor who is you is a row that does nothing
 * except look like protection.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindFirst = vi.fn(async (_args: unknown) => null as unknown);
const userFindMany = vi.fn(async (_args: unknown) => [] as unknown[]);
const successorUpsert = vi.fn(async (_args: unknown) => ({}) as unknown);
const successorFindUnique = vi.fn(async (_args: unknown) => null as unknown);
const successorDeleteMany = vi.fn(async (_args: unknown) => ({ count: 1 }));

vi.mock("@polaris/db", () => ({
    prisma: {
        user: { findFirst: userFindFirst, findMany: userFindMany },
        accountSuccessor: {
            upsert: successorUpsert,
            findUnique: successorFindUnique,
            deleteMany: successorDeleteMany
        },
        // What the card may say under the successor's name is a privacy
        // question now, and it is answered from these. Nobody here has settings,
        // so everybody is on the defaults - which keep an address to themselves.
        userPrivacy: { findMany: async () => [] },
        privacyFieldList: { findMany: async () => [] },
        privacyListMember: { findMany: async () => [] }
    }
}));

vi.mock("@/lib/friends-service", () => ({ friendIds: async () => new Set<string>() }));

const { clearSuccessor, isSuccessorOf, setSuccessor, SuccessorError } = await import(
    "../../src/lib/successor-service"
);

/** What getSuccessor reads back after a write. */
function named(successorId: string) {
    successorFindUnique.mockResolvedValue({
        acknowledgedAt: new Date("2026-01-01T00:00:00.000Z"),
        successor: {
            id: successorId,
            name: "Ana Garcia",
            email: "ana@example.com",
            username: "ana"
        }
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    userFindFirst.mockResolvedValue(null);
    userFindMany.mockResolvedValue([]);
    successorFindUnique.mockResolvedValue(null);
});

describe("setSuccessor", () => {
    it("takes a username or an address", async () => {
        userFindFirst.mockResolvedValue({ id: "heir-1", name: "Ana Garcia" });
        named("heir-1");

        const view = await setSuccessor("me", "Ana@Example.com");
        expect(view.userId).toBe("heir-1");
        // Matched lowercased, so the address is found however it was typed.
        expect(userFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { OR: [{ email: "ana@example.com" }, { username: "ana@example.com" }] }
            })
        );
    });

    it("takes a full name, normalized the way names are stored", async () => {
        userFindMany.mockResolvedValue([{ id: "heir-1", name: "Ana Garcia" }]);
        named("heir-1");

        await setSuccessor("me", "  ana   garcia ");
        expect(userFindMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { name: "Ana Garcia" } })
        );
    });

    it("refuses a name two accounts share rather than guessing", async () => {
        userFindMany.mockResolvedValue([
            { id: "heir-1", name: "Ana Garcia" },
            { id: "heir-2", name: "Ana Garcia" }
        ]);
        await expect(setSuccessor("me", "Ana Garcia")).rejects.toBeInstanceOf(SuccessorError);
        expect(successorUpsert).not.toHaveBeenCalled();
    });

    it("refuses somebody who does not exist", async () => {
        await expect(setSuccessor("me", "nobody@example.com")).rejects.toBeInstanceOf(
            SuccessorError
        );
        expect(successorUpsert).not.toHaveBeenCalled();
    });

    it("refuses naming yourself", async () => {
        userFindFirst.mockResolvedValue({ id: "me", name: "Me" });
        await expect(setSuccessor("me", "me@example.com")).rejects.toBeInstanceOf(SuccessorError);
        expect(successorUpsert).not.toHaveBeenCalled();
    });
});

describe("isSuccessorOf", () => {
    it("answers yes only for the account the holder named", async () => {
        successorFindUnique.mockResolvedValue({ successorId: "heir-1" });
        expect(await isSuccessorOf("heir-1", "holder")).toBe(true);
        expect(await isSuccessorOf("heir-2", "holder")).toBe(false);
    });

    it("answers no when the holder named nobody", async () => {
        successorFindUnique.mockResolvedValue(null);
        expect(await isSuccessorOf("heir-1", "holder")).toBe(false);
    });

    it("answers no for an empty id rather than reading a row", async () => {
        expect(await isSuccessorOf("", "holder")).toBe(false);
        expect(await isSuccessorOf("heir-1", "")).toBe(false);
        expect(successorFindUnique).not.toHaveBeenCalled();
    });

    it("answers no for yourself, whatever the table says", async () => {
        successorFindUnique.mockResolvedValue({ successorId: "me" });
        expect(await isSuccessorOf("me", "me")).toBe(false);
    });
});

describe("clearSuccessor", () => {
    it("removes the row for that account only", async () => {
        await clearSuccessor("me");
        expect(successorDeleteMany).toHaveBeenCalledWith({ where: { userId: "me" } });
    });
});
