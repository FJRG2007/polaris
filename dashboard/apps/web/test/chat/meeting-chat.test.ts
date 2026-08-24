/**
 * What a call's chat may carry, who may put it there, and what happens to it.
 *
 * The three things worth pinning down are the three that go wrong quietly.
 *
 * A seat rather than an account is the whole design - it is what lets a guest
 * take part at all - so an option id, which is a uuid anybody can guess, must be
 * checked against the seat's own meeting and not against the one the caller
 * named. Without that line, holding a seat in any call is a vote in every call.
 *
 * A hidden poll must not send the counts. A flag saying "do not draw these" puts
 * the numbers in the response anyway, where anybody who wants them can read them
 * - which is not hiding a poll, it is asking politely.
 *
 * And it all has to go when the call goes. A meeting is never deleted, only
 * marked ended, so nothing was taking the messages with it: they sat in the
 * database for good, unreachable from every screen and readable by anybody who
 * could read the database. The room told the people in it otherwise.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Seated {
    id: string;
    userId: string | null;
    name: string;
    admission: "admitted" | "waiting" | "denied";
    joinedAt: Date;
}

const SEAT = { meetingId: "m1", participantId: "p-guest" };
let seated: Seated;

/** The option the tests vote on, and which meeting it really belongs to. */
let option: { id: string; pollId: string; meetingId: string; multiple: boolean; closedAt: Date | null } | null;

const created: unknown[] = [];
const deletedMessages = vi.fn(async (args?: unknown) => {
    void args;
    return { count: 3 };
});
const votesDeleted = vi.fn(async () => ({ count: 0 }));
const voteCreated = vi.fn(async () => ({ id: "v1" }));
/** What the storage was asked to remove, and in which order the two halves ran. */
const removed: string[] = [];
const order: string[] = [];

vi.mock("@/lib/chat/meetings", () => ({
    requireSeated: async () => seated
}));
vi.mock("@/lib/chat/meeting-events", () => ({ publishMeetingEvent: vi.fn() }));

vi.mock("@polaris/db", () => ({
    prisma: {
        meetingMessage: {
            create: async (args: unknown) => {
                created.push(args);
                return { id: "msg-1" };
            },
            deleteMany: async (args: unknown) => {
                order.push("messages");
                return deletedMessages(args);
            },
            findMany: async () => rows
        },
        meetingPollOption: {
            findUnique: async () =>
                option
                    ? {
                          id: option.id,
                          pollId: option.pollId,
                          poll: {
                              multiple: option.multiple,
                              closedAt: option.closedAt,
                              message: { meetingId: option.meetingId }
                          }
                      }
                    : null
        },
        meetingPollVote: {
            findUnique: async () => null,
            delete: vi.fn(),
            deleteMany: votesDeleted,
            create: voteCreated
        },
        meetingAttachment: {
            findMany: async () => {
                order.push("storages");
                return [{ connectionId: null }];
            }
        },
        $transaction: async (operations: unknown[]) => Promise.all(operations)
    }
}));

// The storage layer, not the module under test: `discardMeetingChat` calls its
// own file-removal directly, so mocking that export would prove nothing.
vi.mock("@/lib/chat/attachments", () => ({
    chatTarget: async () => ({ id: "local" }),
    readStored: async () => null,
    removeStoredFiles: async () => undefined
}));
vi.mock("@/lib/storage-target", () => ({
    LOCAL_TARGET: "local",
    placeFile: async () => ({ targetId: "local" }),
    driverForTarget: async () => ({
        delete: async (path: string) => {
            removed.push(path);
        },
        dispose: async () => undefined
    })
}));

/** The rows `saidInMeeting` reads. Set per test. */
let rows: unknown[] = [];

const room = await import("@/lib/chat/meeting-chat");
const files = await import("@/lib/chat/meeting-files");

beforeEach(() => {
    seated = {
        id: "p-guest",
        userId: null,
        name: "Ada",
        admission: "admitted",
        joinedAt: new Date("2026-01-01T00:00:00Z")
    };
    option = { id: "o1", pollId: "poll-1", meetingId: "m1", multiple: false, closedAt: null };
    created.length = 0;
    rows = [];
    deletedMessages.mockClear();
    removed.length = 0;
    order.length = 0;
    votesDeleted.mockClear();
    voteCreated.mockClear();
});

describe("saying something", () => {
    it("takes a line that is only a file, because that is what a call's chat is for", async () => {
        await room.sayInMeeting(SEAT, "", [
            { name: "shot.png", size: 12, contentType: "image/png", connectionId: null, path: "p/1" }
        ]);
        expect(created).toHaveLength(1);
    });

    it("refuses a line that is nothing at all", async () => {
        await expect(room.sayInMeeting(SEAT, "   ")).rejects.toThrow(/write something/i);
    });

    it("refuses anybody still waiting at the door", async () => {
        seated = { ...seated, admission: "waiting" };
        await expect(room.sayInMeeting(SEAT, "hello")).rejects.toThrow(/waiting to be let in/i);
    });
});

describe("answering a question", () => {
    it("refuses an answer belonging to another call", async () => {
        // An option id is a uuid anybody can guess. Checked against the seat's
        // own meeting rather than against the one the caller named, or a seat in
        // any call would be a vote in every call.
        option = { ...option!, meetingId: "m2" };
        await expect(room.voteInMeeting(SEAT, "o1")).rejects.toThrow(/not in this call/i);
        expect(voteCreated).not.toHaveBeenCalled();
    });

    it("refuses one that has been closed", async () => {
        option = { ...option!, closedAt: new Date() };
        await expect(room.voteInMeeting(SEAT, "o1")).rejects.toThrow(/closed/i);
    });

    it("replaces the previous answer when only one may be held", async () => {
        await room.voteInMeeting(SEAT, "o1");
        expect(votesDeleted).toHaveBeenCalled();
        expect(voteCreated).toHaveBeenCalled();
    });

    it("keeps the previous one when the question allows several", async () => {
        option = { ...option!, multiple: true };
        await room.voteInMeeting(SEAT, "o1");
        expect(votesDeleted).not.toHaveBeenCalled();
        expect(voteCreated).toHaveBeenCalled();
    });
});

describe("a poll whose results are hidden", () => {
    /** One message holding one poll with two answers and three votes on it. */
    const withPoll = (hideResults: boolean, closedAt: Date | null) => [
        {
            id: "msg-1",
            participantId: "p-other",
            body: "Which day?",
            createdAt: new Date("2026-01-01T00:00:00Z"),
            participant: { name: "Grace", userId: "u-grace" },
            attachments: [],
            poll: {
                multiple: false,
                hideResults,
                closedAt,
                options: [
                    {
                        id: "o1",
                        text: "Tuesday",
                        votes: [{ participantId: "p-guest" }, { participantId: "p-x" }]
                    },
                    { id: "o2", text: "Wednesday", votes: [{ participantId: "p-y" }] }
                ]
            }
        }
    ];

    it("sends no counts at all while it is running", async () => {
        rows = withPoll(true, null);
        const [line] = await room.saidInMeeting(SEAT);
        expect(line?.poll?.hidden).toBe(true);
        expect(line?.poll?.total).toBe(0);
        expect(line?.poll?.options.map((option) => option.votes)).toEqual([0, 0]);
    });

    it("still says which one the reader picked, since nothing else does", async () => {
        rows = withPoll(true, null);
        const [line] = await room.saidInMeeting(SEAT);
        expect(line?.poll?.options.map((option) => option.mine)).toEqual([true, false]);
    });

    it("hands over the counts once it closes", async () => {
        rows = withPoll(true, new Date("2026-01-01T01:00:00Z"));
        const [line] = await room.saidInMeeting(SEAT);
        expect(line?.poll?.hidden).toBe(false);
        expect(line?.poll?.total).toBe(3);
    });
});

describe("clearing a call out", () => {
    it("deletes the messages and the folder holding their files", async () => {
        await files.discardMeetingChat("m1");
        expect(deletedMessages).toHaveBeenCalledWith({ where: { meetingId: "m1" } });
        expect(removed).toEqual(["polaris/meetings/m1"]);
    });

    it("asks which storages hold them before the rows that say so are gone", async () => {
        // The rows are the only record of where the bytes went. Reading them
        // afterwards finds nothing, and the files stay on the disk for good.
        await files.discardMeetingChat("m1");
        expect(order).toEqual(["storages", "messages"]);
    });
});
