/**
 * Friendship: mutual, one row, and no way to make somebody your friend on your
 * own.
 *
 * Two cases carry the weight. Asking somebody who has already asked you accepts
 * theirs rather than storing a second row - otherwise two people reaching for
 * each other at the same moment both end up waiting for the other, which is a
 * deadlock nobody would recognise as one. And only the person asked may accept,
 * because an implementation that lets either side flip the status is one where
 * asking makes it so.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    requesterId: string;
    addresseeId: string;
    status: string;
}

let rows: Row[] = [];
let created: { requesterId: string; addresseeId: string }[] = [];
let deleted: string[] = [];

/** The `where` shapes this module actually builds. */
function match(row: Row, where: Record<string, unknown>): boolean {
    const clauses = (where.OR as Record<string, string>[] | undefined) ?? [where as Record<string, string>];
    const status = where.status as string | undefined;
    if (status && row.status !== status) return false;
    return clauses.some((clause) =>
        Object.entries(clause).every(([field, value]) =>
            field === "status" ? row.status === value : row[field as "id"] === value
        )
    );
}

vi.mock("@polaris/db", () => ({
    prisma: {
        user: { findUnique: async () => ({ id: "grace" }) },
        friendship: {
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
                rows.find((row) => match(row, where)) ?? null,
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                rows.filter((row) => match(row, where)),
            findUnique: async ({ where }: { where: { id: string } }) =>
                rows.find((row) => row.id === where.id) ?? null,
            create: async ({ data }: { data: { requesterId: string; addresseeId: string } }) => {
                created.push(data);
                rows.push({ id: `new-${created.length}`, ...data, status: "pending" });
                return {};
            },
            update: async ({
                where,
                data
            }: {
                where: { id: string };
                data: { status: string };
            }) => {
                const row = rows.find((entry) => entry.id === where.id);
                if (row) row.status = data.status;
                return {};
            },
            delete: async ({ where }: { where: { id: string } }) => {
                deleted.push(where.id);
                rows = rows.filter((row) => row.id !== where.id);
                return {};
            },
            deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
                const going = rows.filter((row) => match(row, where));
                deleted.push(...going.map((row) => row.id));
                rows = rows.filter((row) => !going.includes(row));
                return { count: going.length };
            }
        }
    }
}));

const friends = await import("@/lib/friends-service");

beforeEach(() => {
    rows = [];
    created = [];
    deleted = [];
});

describe("asking", () => {
    it("stores a request", async () => {
        await friends.requestFriend("ada", "grace");
        expect(created).toEqual([{ requesterId: "ada", addresseeId: "grace" }]);
        expect(rows[0]?.status).toBe("pending");
    });

    it("accepts theirs when they asked first", async () => {
        // Both reaching at once is not an error state, and two open requests
        // would leave each waiting for the other.
        rows = [{ id: "r1", requesterId: "grace", addresseeId: "ada", status: "pending" }];
        await friends.requestFriend("ada", "grace");
        expect(created).toEqual([]);
        expect(rows[0]?.status).toBe("accepted");
    });

    it("does nothing when it was already asked", async () => {
        rows = [{ id: "r1", requesterId: "ada", addresseeId: "grace", status: "pending" }];
        await friends.requestFriend("ada", "grace");
        expect(created).toEqual([]);
        expect(rows).toHaveLength(1);
    });

    it("does nothing when they already are friends", async () => {
        rows = [{ id: "r1", requesterId: "grace", addresseeId: "ada", status: "accepted" }];
        await friends.requestFriend("ada", "grace");
        expect(created).toEqual([]);
    });

    it("refuses somebody asking themselves", async () => {
        await expect(friends.requestFriend("ada", "ada")).rejects.toThrow(/already yourself/);
    });
});

describe("answering", () => {
    it("is the person who was asked", async () => {
        rows = [{ id: "r1", requesterId: "grace", addresseeId: "ada", status: "pending" }];
        await friends.respondToRequest("ada", "r1", true);
        expect(rows[0]?.status).toBe("accepted");
    });

    it("is not the person who asked", async () => {
        // Otherwise asking makes it so.
        rows = [{ id: "r1", requesterId: "ada", addresseeId: "grace", status: "pending" }];
        await expect(friends.respondToRequest("ada", "r1", true)).rejects.toThrow(
            /Only the person asked/
        );
        expect(rows[0]?.status).toBe("pending");
    });

    it("lets either of them withdraw, and leaves no record", async () => {
        // A stored refusal is a thing to clean up, and it would stop them ever
        // being asked again by somebody they have since come to know.
        rows = [{ id: "r1", requesterId: "ada", addresseeId: "grace", status: "pending" }];
        await friends.respondToRequest("ada", "r1", false);
        expect(deleted).toEqual(["r1"]);
    });

    it("ignores one that is not theirs at all", async () => {
        rows = [{ id: "r1", requesterId: "grace", addresseeId: "alan", status: "pending" }];
        await expect(friends.respondToRequest("ada", "r1", false)).rejects.toThrow(/not yours/);
    });
});

describe("reading it back", () => {
    it("is mutual, whichever way round the row is", async () => {
        rows = [{ id: "r1", requesterId: "grace", addresseeId: "ada", status: "accepted" }];
        expect(await friends.areFriends("ada", "grace")).toBe(true);
        expect(await friends.areFriends("grace", "ada")).toBe(true);
    });

    it("does not count a request as a friendship", async () => {
        rows = [{ id: "r1", requesterId: "grace", addresseeId: "ada", status: "pending" }];
        expect(await friends.areFriends("ada", "grace")).toBe(false);
    });
});

describe("stopping", () => {
    it("takes the row, so it can be asked again later", async () => {
        rows = [{ id: "r1", requesterId: "grace", addresseeId: "ada", status: "accepted" }];
        await friends.removeFriend("ada", "grace");
        expect(deleted).toEqual(["r1"]);
        expect(await friends.areFriends("ada", "grace")).toBe(false);
    });
});
