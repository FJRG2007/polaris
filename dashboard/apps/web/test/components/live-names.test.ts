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
 *
 * Nicknames are part of that half rather than a separate feature, and they are the
 * reason this file grew. The answer here OVERWRITES the name a page was rendered
 * with - the store keeps it as "what they are called now" and the rendered name is
 * only the fallback - so a nickname the server had already applied to the page was
 * replaced by the person's real name on the next paint, and came back no matter how
 * many times somebody reloaded. A nickname that does not survive this function does
 * not survive at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    name: string;
    updatedAt: Date;
}

interface Named {
    ownerId: string;
    subjectId: string;
    nickname: string;
}

let users: Row[] = [];
let nicknames: Named[] = [];
let asked: Record<string, unknown> | null = null;
/** Every nickname lookup that went out, so a test can say one did not. */
let nicknameLookups: Record<string, unknown>[] = [];

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
        // What one reader calls people. Keyed on the reader as well as the subject,
        // which is the whole point of the table: the same person is "Dad" in one
        // account's Polaris and unchanged in everybody else's.
        contactName: {
            findMany: async (query: { where: Record<string, unknown> }) => {
                nicknameLookups.push(query.where);
                const ownerId = query.where.ownerId as string;
                const ids = (query.where.subjectId as { in: string[] }).in;
                return nicknames
                    .filter((row) => row.ownerId === ownerId && ids.includes(row.subjectId))
                    .map((row) => ({ subjectId: row.subjectId, nickname: row.nickname }));
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
    nicknameLookups = [];
    nicknames = [];
    users = [
        { id: "u1", name: "Ada", updatedAt: EARLIER },
        { id: "u2", name: "Grace", updatedAt: LATER }
    ];
});

describe("what everybody is called", () => {
    it("answers for the people being drawn", async () => {
        const names = await namesFor("me", ["u1", "u2"]);
        expect(names.get("u1")).toBe("Ada");
        expect(names.get("u2")).toBe("Grace");
    });

    it("asks about each of them once", async () => {
        await namesFor("me", ["u1", "u1", "u2"]);
        expect((asked?.id as { in: string[] }).in).toEqual(["u1", "u2"]);
    });

    it("has nothing to ask about an empty screen", async () => {
        expect((await namesFor("me", [])).size).toBe(0);
        expect(asked).toBeNull();
        expect(nicknameLookups).toEqual([]);
    });

    it("answers with what this reader calls them", async () => {
        nicknames = [{ ownerId: "me", subjectId: "u1", nickname: "Dad" }];
        const names = await namesFor("me", ["u1", "u2"]);
        expect(names.get("u1")).toBe("Dad");
        // Somebody with no nickname is still called what they call themselves: a
        // missing one is the real name, never an empty string.
        expect(names.get("u2")).toBe("Grace");
    });

    it("keeps one reader's names out of another's", async () => {
        nicknames = [{ ownerId: "me", subjectId: "u1", nickname: "Dad" }];
        expect((await namesFor("somebody-else", ["u1"])).get("u1")).toBe("Ada");
    });
});

describe("what has changed since the last answer", () => {
    // The ordinary revalidation, and the reason an idle tab costs nothing: forty
    // people, none of whom renamed themselves, is an empty answer.
    it("leaves out the ones that did not move", async () => {
        const moved = await nameChangesSince("me", ["u1", "u2"], new Date("2026-09-06T11:00:00Z"));
        expect([...moved.keys()]).toEqual(["u2"]);
    });

    it("says nothing at all when nobody moved", async () => {
        const moved = await nameChangesSince("me", ["u1", "u2"], new Date("2026-09-06T13:00:00Z"));
        expect(moved.size).toBe(0);
    });

    it("asks about nobody's nickname when nobody moved", async () => {
        // What keeps a tab that is merely open from being a workload: the quiet
        // answer is one indexed lookup and then nothing.
        await nameChangesSince("me", ["u1", "u2"], new Date("2026-09-06T13:00:00Z"));
        expect(nicknameLookups).toEqual([]);
    });

    it("still answers with this reader's name for somebody who renamed themselves", async () => {
        // The case that made reloading useless. Grace renames herself, the
        // revalidation carries her new name, and a reader who calls her something
        // else must not have their own name replaced by it.
        nicknames = [{ ownerId: "me", subjectId: "u2", nickname: "G" }];
        const moved = await nameChangesSince("me", ["u1", "u2"], new Date("2026-09-06T11:00:00Z"));
        expect(moved.get("u2")).toBe("G");
    });
});
