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
    note?: string | null;
}

let rows: Row[] = [];
let created: { requesterId: string; addresseeId: string }[] = [];
let deleted: string[] = [];

/** The `where` shapes this module actually builds. */
function match(row: Row, where: Record<string, unknown>): boolean {
    const clauses = (where.OR as Record<string, string>[] | undefined) ?? [
        where as Record<string, string>
    ];
    const status = where.status as string | undefined;
    if (status && row.status !== status) return false;
    return clauses.some((clause) =>
        Object.entries(clause).every(([field, value]) =>
            field === "status" ? row.status === value : row[field as "id"] === value
        )
    );
}

/** Whether the person being asked takes requests from this asker. True unless a
 *  test says otherwise, which is the default every account is on. */
let takesRequests = true;

// The setting is read through the privacy service, and the service asks this
// module who somebody's friends are - so the real one is not importable here and
// would not be the thing under test anyway.
vi.mock("@/lib/privacy-service", () => ({ maySee: async () => takesRequests }));

// Becoming friends makes the two of them follow each other. Recorded rather than
// performed, so the assertions can say it happened without this file carrying a
// second copy of the follow table.
const followed: { subjectId: string; userId: string }[] = [];
vi.mock("@/lib/follow/follow", () => ({
    follow: async (_kind: string, subjectId: string, userId: string) => {
        followed.push({ subjectId, userId });
    }
}));

// The conversation two friends are owed. Recorded rather than opened: the chat
// service is this module's collaborator and not the subject here, and it is reached
// through a dynamic import - chat imports this module back, so the real one cannot
// be pulled in from the top of it.
const opened: { actorId: string; withIds: string[] }[] = [];
/** Who may use chat in a given test. Both of them, unless a test says otherwise. */
let chatAllowed = new Set<string>(["ada", "grace"]);
vi.mock("@/lib/chat/access", () => ({
    messageable: async (ids: readonly string[]) => new Set(ids.filter((id) => chatAllowed.has(id)))
}));
vi.mock("@/lib/chat/chat-service", () => ({
    openDirect: async (actor: { id: string }, withIds: readonly string[]) => {
        opened.push({ actorId: actor.id, withIds: [...withIds] });
        return "channel-1";
    }
}));

/** The bell, as far as friend alerts go. */
interface Notice {
    id: string;
    userId: string;
    type: string;
    actionRequired: boolean;
    metadata: string | null;
}
let notices: Notice[] = [];

function noticeMatches(row: Notice, where: Record<string, unknown>): boolean {
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.type !== undefined && row.type !== where.type) return false;
    if (where.actionRequired !== undefined && row.actionRequired !== where.actionRequired)
        return false;
    const contains = (where.metadata as { contains?: string } | undefined)?.contains;
    if (contains !== undefined && !(row.metadata ?? "").includes(contains)) return false;
    const id = where.id as { gt?: string; in?: string[] } | undefined;
    if (id?.gt !== undefined && !(row.id > id.gt)) return false;
    if (id?.in !== undefined && !id.in.includes(row.id)) return false;
    return true;
}

vi.mock("@polaris/db", () => ({
    prisma: {
        notification: {
            findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
                notices
                    .filter((row) => noticeMatches(row, where))
                    .sort((a, b) => a.id.localeCompare(b.id))
                    .slice(0, take ?? Infinity),
            deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
                const going = notices.filter((row) => noticeMatches(row, where));
                notices = notices.filter((row) => !going.includes(row));
                return { count: going.length };
            }
        },
        // Nobody has blocked anybody here; blocking has its own test.
        userBlock: { findFirst: async () => null },
        user: { findUnique: async () => ({ id: "grace" }) },
        friendship: {
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
                rows.find((row) => match(row, where)) ?? null,
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                rows.filter((row) => match(row, where)),
            findUnique: async ({ where }: { where: { id: string } }) =>
                rows.find((row) => row.id === where.id) ?? null,
            create: async ({
                data
            }: {
                data: { requesterId: string; addresseeId: string; note?: string | null };
            }) => {
                created.push(data);
                rows.push({ id: `new-${created.length}`, ...data, status: "pending" });
                return {};
            },
            update: async ({
                where,
                data
            }: {
                where: { id: string };
                data: { status: string; note?: string | null };
            }) => {
                const row = rows.find((entry) => entry.id === where.id);
                if (row) row.status = data.status;
                if (row && data.note !== undefined) row.note = data.note;
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
const { FRIEND_NOTE_MAX, friendNoteSchema, normalizeFriendNote } = await import(
    "@/lib/friend-note"
);

beforeEach(() => {
    rows = [];
    notices = [];
    created = [];
    deleted = [];
    followed.length = 0;
    takesRequests = true;
    opened.length = 0;
    chatAllowed = new Set(["ada", "grace"]);
});

describe("the conversation a friendship is owed", () => {
    it("opens one when a request is accepted", async () => {
        rows = [{ id: "r1", requesterId: "grace", addresseeId: "ada", status: "pending" }];
        await friends.respondToRequest("ada", "r1", true);
        expect(opened).toEqual([{ actorId: "ada", withIds: ["grace"] }]);
    });

    it("opens one when asking somebody who had already asked", async () => {
        // The other accept path. It used to be the one that got forgotten, which is
        // why both are asserted rather than only the obvious one.
        rows = [{ id: "r1", requesterId: "grace", addresseeId: "ada", status: "pending" }];
        await friends.requestFriend("ada", "grace");
        expect(opened).toEqual([{ actorId: "ada", withIds: ["grace"] }]);
    });

    it("opens none for a request that is only asked", async () => {
        await friends.requestFriend("ada", "grace");
        expect(opened).toEqual([]);
    });

    it("opens none when the other one cannot use chat", async () => {
        // Both sides are checked, not just the one being messaged: nobody pressed a
        // button here, so neither side's right can be taken for granted.
        chatAllowed = new Set(["ada"]);
        rows = [{ id: "r1", requesterId: "grace", addresseeId: "ada", status: "pending" }];
        await friends.respondToRequest("ada", "r1", true);
        expect(opened).toEqual([]);
    });

    it("opens none when the one accepting cannot use chat", async () => {
        chatAllowed = new Set(["grace"]);
        rows = [{ id: "r1", requesterId: "grace", addresseeId: "ada", status: "pending" }];
        await friends.respondToRequest("ada", "r1", true);
        expect(opened).toEqual([]);
    });

    it("still records the friendship when the conversation cannot be opened", async () => {
        // The friendship is what happened. A conversation that did not open is one
        // search box away from being opened by hand.
        chatAllowed = new Set();
        rows = [{ id: "r1", requesterId: "grace", addresseeId: "ada", status: "pending" }];
        await friends.respondToRequest("ada", "r1", true);
        expect(rows[0]?.status).toBe("accepted");
        expect(followed).toHaveLength(2);
    });

    it("names the other person whichever way the row points", async () => {
        const partners = friends.friendPartnerIds(
            [
                { requesterId: "ada", addresseeId: "grace" },
                { requesterId: "linus", addresseeId: "ada" },
                // A row pointing at itself would otherwise ask for a conversation
                // with oneself, be refused, and take the rest of the list with it.
                { requesterId: "ada", addresseeId: "ada" }
            ],
            "ada"
        );
        expect(partners).toEqual(["grace", "linus"]);
    });

    it("catches up the ones owed from before access arrived", async () => {
        rows = [
            { id: "r1", requesterId: "ada", addresseeId: "grace", status: "accepted" },
            { id: "r2", requesterId: "linus", addresseeId: "ada", status: "accepted" },
            // Not accepted, so not owed anything yet.
            { id: "r3", requesterId: "ada", addresseeId: "pending-person", status: "pending" }
        ];
        chatAllowed = new Set(["ada", "grace", "linus"]);
        await friends.openMissingFriendDms("ada");
        expect(opened).toEqual([
            { actorId: "ada", withIds: ["grace"] },
            { actorId: "ada", withIds: ["linus"] }
        ]);
    });

    it("skips a friend who still cannot use chat when catching up", async () => {
        rows = [
            { id: "r1", requesterId: "ada", addresseeId: "grace", status: "accepted" },
            { id: "r2", requesterId: "ada", addresseeId: "linus", status: "accepted" }
        ];
        chatAllowed = new Set(["ada", "grace"]);
        await friends.openMissingFriendDms("ada");
        expect(opened).toEqual([{ actorId: "ada", withIds: ["grace"] }]);
    });
});

describe("asking", () => {
    it("stores a request", async () => {
        await friends.requestFriend("ada", "grace");
        expect(created).toEqual([{ requesterId: "ada", addresseeId: "grace", note: null }]);
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

    it("is refused when they take no requests from this asker", async () => {
        // Their setting, not the asker's. Refused with the sentence a block
        // gives, because a different one would say which of the two it was.
        takesRequests = false;
        await expect(friends.requestFriend("ada", "grace")).rejects.toThrow(/cannot send/i);
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

    it("makes the two of them follow each other", async () => {
        // Two people who have just agreed to be friends have already said the
        // smaller thing following says, so neither is asked to press it again.
        // Both directions, because a friendship is mutual.
        rows = [{ id: "r1", requesterId: "grace", addresseeId: "ada", status: "pending" }];
        await friends.respondToRequest("ada", "r1", true);
        expect(followed).toEqual(
            expect.arrayContaining([
                { subjectId: "grace", userId: "ada" },
                { subjectId: "ada", userId: "grace" }
            ])
        );
    });

    it("follows both ways on the other path into a friendship too", async () => {
        // Asking somebody who already asked you accepts theirs, and that is a
        // friendship arriving by a different door - it has to end the same way.
        rows = [{ id: "r1", requesterId: "grace", addresseeId: "ada", status: "pending" }];
        await friends.requestFriend("ada", "grace");
        expect(followed).toHaveLength(2);
    });

    it("does not follow anybody when the answer is no", async () => {
        rows = [{ id: "r1", requesterId: "grace", addresseeId: "ada", status: "pending" }];
        await friends.respondToRequest("ada", "r1", false);
        expect(followed).toEqual([]);
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

/** A "wants to be added" alert in somebody's bell about somebody. */
function asked(id: string, userId: string, personId: string, actionRequired = true): Notice {
    return {
        id,
        userId,
        type: "account.friend",
        actionRequired,
        metadata: JSON.stringify({ personId })
    };
}

describe("the note on a request", () => {
    it("is stored with the request and read back with it", async () => {
        await friends.requestFriend("ada", "grace", "We met at the meetup");
        expect(created).toEqual([
            { requesterId: "ada", addresseeId: "grace", note: "We met at the meetup" }
        ]);
    });

    it("is cleared when the request is accepted, and the request alert goes", async () => {
        rows = [
            { id: "r1", requesterId: "grace", addresseeId: "ada", status: "pending", note: "hi" }
        ];
        notices = [asked("n1", "ada", "grace"), asked("n2", "ada", "alan")];
        await friends.respondToRequest("ada", "r1", true);
        expect(rows[0]?.note).toBeNull();
        expect(notices.map((row) => row.id)).toEqual(["n2"]);
    });

    it("is cleared on the other path into a friendship too", async () => {
        rows = [
            { id: "r1", requesterId: "grace", addresseeId: "ada", status: "pending", note: "hi" }
        ];
        notices = [asked("n1", "ada", "grace")];
        await friends.requestFriend("ada", "grace");
        expect(rows[0]?.note).toBeNull();
        expect(notices).toEqual([]);
    });

    it("goes with the row when turned down or withdrawn, and so does the alert", async () => {
        rows = [
            { id: "r1", requesterId: "grace", addresseeId: "ada", status: "pending", note: "hi" }
        ];
        notices = [asked("n1", "ada", "grace")];
        await friends.respondToRequest("grace", "r1", false);
        expect(rows).toEqual([]);
        expect(notices).toEqual([]);
    });
});

describe("what a friendship leaves behind", () => {
    it("drops the friend alerts in both bells when it ends", async () => {
        rows = [{ id: "r1", requesterId: "grace", addresseeId: "ada", status: "accepted" }];
        notices = [
            asked("n1", "grace", "ada", false),
            asked("n2", "ada", "grace", false),
            asked("n3", "ada", "alan", false)
        ];
        await friends.removeFriend("ada", "grace");
        expect(notices.map((row) => row.id)).toEqual(["n3"]);
    });

    it("ends a waiting request on a block and leaves a friendship alone", async () => {
        rows = [
            { id: "r1", requesterId: "grace", addresseeId: "ada", status: "pending" },
            { id: "r2", requesterId: "alan", addresseeId: "ada", status: "accepted" }
        ];
        notices = [asked("n1", "ada", "grace")];
        await friends.endPendingRequests("ada", "grace");
        await friends.endPendingRequests("ada", "alan");
        expect(rows.map((row) => row.id)).toEqual(["r2"]);
        expect(notices).toEqual([]);
    });

    it("sweeps request alerts whose request is gone and keeps the open ones", async () => {
        rows = [{ id: "r1", requesterId: "grace", addresseeId: "ada", status: "pending" }];
        notices = [
            asked("n1", "ada", "grace"),
            asked("n2", "ada", "alan"),
            asked("n3", "ada", "alan", false),
            {
                id: "n4",
                userId: "ada",
                type: "account.friend",
                actionRequired: true,
                metadata: null
            }
        ];
        expect(await friends.sweepEndedFriendRequestNotices()).toEqual({ removed: 1 });
        expect(notices.map((row) => row.id)).toEqual(["n1", "n3", "n4"]);
    });
});

describe("the note's own rule", () => {
    it("is trimmed, loses control characters and folds blank lines", () => {
        expect(normalizeFriendNote("  hi\u0007 there\r\n\n\n\nbye  ")).toBe("hi there\n\nbye");
    });

    it("turns empty into no note and refuses one past the limit", () => {
        expect(friendNoteSchema.parse("   ")).toBeNull();
        expect(friendNoteSchema.parse(undefined)).toBeNull();
        expect(friendNoteSchema.safeParse("x".repeat(FRIEND_NOTE_MAX + 1)).success).toBe(false);
        expect(friendNoteSchema.parse(" ok ")).toBe("ok");
    });
});
