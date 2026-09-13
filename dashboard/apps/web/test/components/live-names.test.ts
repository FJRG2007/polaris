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
 * Nicknames ride the same answer, and what this file pins down is that they ride
 * BESIDE the names rather than over them. The browser keeps this answer as "what
 * they are called now" and it overwrites the name every screen was rendered
 * with, so a nickname left out of it appears for one paint and then vanishes -
 * and a nickname merged into it replaces a real name on the screens where a name
 * is a claim about who somebody is rather than a note the reader keeps: a
 * moderation queue, an administration table, a field that names an account. Two
 * maps is what lets the screen decide, which is where that decision belongs.
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
        const { names } = await namesFor("me", ["u1", "u2"]);
        expect(names.get("u1")).toBe("Ada");
        expect(names.get("u2")).toBe("Grace");
    });

    it("asks about each of them once", async () => {
        await namesFor("me", ["u1", "u1", "u2"]);
        expect((asked?.id as { in: string[] }).in).toEqual(["u1", "u2"]);
    });

    it("has nothing to ask about an empty screen", async () => {
        const answer = await namesFor("me", []);
        expect(answer.names.size).toBe(0);
        expect(answer.called.size).toBe(0);
        expect(asked).toBeNull();
        expect(nicknameLookups).toEqual([]);
    });

    it("carries what this reader calls them beside what they call themselves", async () => {
        nicknames = [{ ownerId: "me", subjectId: "u1", nickname: "Dad" }];
        const { names, called } = await namesFor("me", ["u1", "u2"]);
        expect(called.get("u1")).toBe("Dad");
        // Both of them, and the real one is untouched: a moderation queue and an
        // administration table are drawn from the same answer as a conversation,
        // and only they know a nickname is not what they may show.
        expect(names.get("u1")).toBe("Ada");
        // Somebody with no nickname is simply absent, which is what lets the
        // browser fall back to their own name rather than to an empty string.
        expect(called.has("u2")).toBe(false);
        expect(names.get("u2")).toBe("Grace");
    });

    it("keeps one reader's names out of another's", async () => {
        nicknames = [{ ownerId: "me", subjectId: "u1", nickname: "Dad" }];
        const answer = await namesFor("somebody-else", ["u1"]);
        expect(answer.called.size).toBe(0);
        expect(answer.names.get("u1")).toBe("Ada");
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

    it("asks about nobody's nickname, whoever moved", async () => {
        // What keeps a tab that is merely open from being a workload: the quiet
        // answer is one indexed lookup and then nothing. A nickname does not
        // change because its subject renamed themselves, and the browser already
        // holds the ones it was told about.
        nicknames = [{ ownerId: "me", subjectId: "u2", nickname: "G" }];
        const moved = await nameChangesSince(["u1", "u2"], new Date("2026-09-06T11:00:00Z"));
        expect(moved.get("u2")).toBe("Grace");
        expect(nicknameLookups).toEqual([]);
    });
});
