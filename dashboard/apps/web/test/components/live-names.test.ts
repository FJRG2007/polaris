/**
 * A name that changes while somebody is looking at it.
 *
 * Renaming yourself moved the direct message list and nothing else: the
 * conversation you were reading, the authors of its messages and the panel down
 * the side all went on saying the old name until the tab was reloaded. A name is
 * changed as often as a decoration and is drawn in the same places, so it rides
 * the pipe that already keeps decorations current rather than getting one of its
 * own - which would be twice the requests to the same server about the same
 * forty people.
 *
 * What is tested here is the server half: which names come back, and that a
 * revalidation answers with the ones that moved rather than with all of them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    name: string;
    updatedAt: Date;
}

let users: Row[] = [];
let asked: Record<string, unknown> | null = null;

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findMany: async (query: { where: Record<string, unknown> }) => {
                asked = query.where;
                const since = (query.where.updatedAt as { gt?: Date } | undefined)?.gt;
                const ids = (query.where.id as { in: string[] }).in;
                return users
                    .filter((row) => ids.includes(row.id))
                    .filter((row) => !since || row.updatedAt > since)
                    .map((row) => ({ id: row.id, name: row.name }));
            }
        },
        userProfileStyle: { findMany: async () => [] }
    }
}));

const { namesFor, nameChangesSince } = await import("@/lib/profile-style-service");

const EARLIER = new Date("2026-09-06T10:00:00Z");
const LATER = new Date("2026-09-06T12:00:00Z");

beforeEach(() => {
    asked = null;
    users = [
        { id: "u1", name: "Ada", updatedAt: EARLIER },
        { id: "u2", name: "Grace", updatedAt: LATER }
    ];
});

describe("what everybody is called", () => {
    it("answers for the people being drawn", async () => {
        const names = await namesFor(["u1", "u2"]);
        expect(names.get("u1")).toBe("Ada");
        expect(names.get("u2")).toBe("Grace");
    });

    it("asks about each of them once", async () => {
        await namesFor(["u1", "u1", "u2"]);
        expect((asked?.id as { in: string[] }).in).toEqual(["u1", "u2"]);
    });

    it("has nothing to ask about an empty screen", async () => {
        expect((await namesFor([])).size).toBe(0);
        expect(asked).toBeNull();
    });
});

describe("what has changed since the last answer", () => {
    // The ordinary revalidation, and the reason an idle tab costs nothing: forty
    // people, none of whom renamed themselves, is an empty answer.
    it("leaves out the ones that did not move", async () => {
        const moved = await nameChangesSince(["u1", "u2"], new Date("2026-09-06T11:00:00Z"));
        expect([...moved.keys()]).toEqual(["u2"]);
    });

    it("says nothing at all when nobody moved", async () => {
        const moved = await nameChangesSince(["u1", "u2"], new Date("2026-09-06T13:00:00Z"));
        expect(moved.size).toBe(0);
    });
});
