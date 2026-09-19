/**
 * A mailbox that holds two folders for the same job.
 *
 * The reported case: an account whose provider files into "Elementos enviados"
 * and which also carries an English "Sent" left behind by another client. Both
 * read as Sent, so the rail drew two and the copy of a sent message went into
 * whichever the database answered with - which is how a message sent from
 * Polaris never appeared in that provider's own webmail.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    role: string;
    roleLocked: boolean;
    roleFlagged: boolean;
    path: string;
}

let folders: Row[] = [];
let asked: Record<string, unknown> | null = null;

function matches(row: Row, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (key === "accountId") return true;
        if (key === "role" && typeof value === "object" && value !== null) {
            return row.role !== (value as { not: string }).not;
        }
        if (key === "id" && typeof value === "object" && value !== null) {
            return ((value as { in: string[] }).in ?? []).includes(row.id);
        }
        return (row as unknown as Record<string, unknown>)[key] === value;
    });
}

vi.mock("@polaris/db", () => ({
    prisma: {
        mailFolder: {
            findFirst: async ({
                where,
                orderBy
            }: {
                where: Record<string, unknown>;
                orderBy: { [key: string]: "asc" | "desc" }[];
            }) => {
                asked = where;
                const found = folders.filter((row) => matches(row, where));
                const sorted = [...found].sort((left, right) => {
                    for (const rule of orderBy) {
                        const [key, direction] = Object.entries(rule)[0] as [
                            keyof Row,
                            "asc" | "desc"
                        ];
                        const a = left[key];
                        const b = right[key];
                        if (a === b) continue;
                        const order = a > b ? 1 : -1;
                        return direction === "desc" ? -order : order;
                    }
                    return 0;
                });
                return sorted[0] ?? null;
            },
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                folders.filter((row) => matches(row, where)),
            updateMany: async ({
                where,
                data
            }: {
                where: Record<string, unknown>;
                data: Record<string, unknown>;
            }) => {
                const hit = folders.filter((row) => matches(row, where));
                for (const row of hit) Object.assign(row, data);
                return { count: hit.length };
            }
        }
    }
}));

const { findFolderForRole } = await import("@/lib/mailbox/folder-roles");

const PROVIDERS_OWN: Row = {
    id: "f-es",
    role: "sent",
    roleLocked: false,
    roleFlagged: true,
    path: "Elementos enviados"
};
const LEFT_BEHIND: Row = {
    id: "f-en",
    role: "sent",
    roleLocked: false,
    roleFlagged: false,
    path: "Sent"
};

beforeEach(() => {
    folders = [];
    asked = null;
});

describe("which folder holds a role", () => {
    it("is the one the server marked as its own, not the one that matched a name", async () => {
        // Listed with the name match first, which is the order that used to win.
        folders = [{ ...LEFT_BEHIND }, { ...PROVIDERS_OWN }];
        expect(await findFolderForRole("a1", "sent")).toMatchObject({ path: "Elementos enviados" });
        expect(asked).toMatchObject({ accountId: "a1", role: "sent" });
    });

    it("is whichever one its owner pointed at, whatever the server says", async () => {
        folders = [
            { ...PROVIDERS_OWN },
            { ...LEFT_BEHIND, roleLocked: true }
        ];
        expect(await findFolderForRole("a1", "sent")).toMatchObject({ path: "Sent" });
    });

    it("is the same answer every time where nothing tells them apart", async () => {
        folders = [
            { ...LEFT_BEHIND, id: "f-b", path: "Sent B" },
            { ...LEFT_BEHIND, id: "f-a", path: "Sent A" }
        ];
        expect(await findFolderForRole("a1", "sent")).toMatchObject({ path: "Sent A" });
    });

    it("has none to answer with when the mailbox has no such folder", async () => {
        folders = [{ ...PROVIDERS_OWN, role: "archive" }];
        expect(await findFolderForRole("a1", "sent")).toBeNull();
    });
});
