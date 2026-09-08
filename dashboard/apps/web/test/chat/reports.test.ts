/**
 * Reporting something, and what the queue is left holding.
 *
 * Three things decide whether this feature is worth having.
 *
 * It is not a way to probe the message table. Reporting proves the conversation
 * first - the same check that let the reader see the message - or an id somebody
 * guessed would be answered with "reported" or "not there", one press at a time.
 *
 * One report per person. A second press is the same report with a new reason,
 * not a second row: a queue where one annoyed reader is ten lines is a queue
 * that gets ignored.
 *
 * And the record outlives the message. What was said is copied onto the report
 * when it is made, because an instance set to leave no trace deletes the row -
 * and a moderation record that vanished with the thing it was about would be a
 * record of nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const MESSAGE = "018f2b7a-0000-7000-8000-0000000000a1";
const CHANNEL = "018f2b7a-0000-7000-8000-0000000000c1";

const findMessage = vi.fn();
const findReport = vi.fn();
const createReport = vi.fn();
const updateReport = vi.fn();
const requireChannel = vi.fn();
const remove = vi.fn();
/** What was on the message, and what the report ends up holding a copy of. */
const findAttachments = vi.fn();
/** How many are still open once one is settled, which is what decides whether
 *  the queue is left able to announce itself again. */
const countReports = vi.fn(async () => 0);
/** The row that says the queue has already announced itself. It behaves like the
 *  real one - a create only the first caller can win. */
const announced = new Set<string>();
const createSetting = vi.fn(async ({ data }: { data: { key: string } }) => {
    if (announced.has(data.key)) throw new Error("Unique constraint failed on the fields: (`key`)");
    announced.add(data.key);
    return data;
});
const deleteSettings = vi.fn(async ({ where }: { where: { key: string } }) => {
    const had = announced.delete(where.key);
    return { count: had ? 1 : 0 };
});
const findReportFiles = vi.fn();
const createReportFiles = vi.fn();
const deleteReportFiles = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        chatMessage: { findUnique: findMessage },
        chatReport: {
            findUnique: findReport,
            create: createReport,
            update: updateReport,
            findMany: vi.fn(async () => []),
            count: countReports
        },
        chatAttachment: { findMany: findAttachments },
        setting: { create: createSetting, deleteMany: deleteSettings },
        chatReportFile: {
            findMany: findReportFiles,
            createMany: createReportFiles,
            deleteMany: deleteReportFiles,
            update: vi.fn(async () => ({}))
        },
        user: { findMany: vi.fn(async () => []) },
        chatChannel: { findMany: vi.fn(async () => []) }
    }
}));
vi.mock("@/lib/chat/link-preview", () => ({ knownPreviews: async () => new Map() }));
class FakeAccessError extends Error {}
vi.mock("@/lib/chat/access", () => ({
    requireChannel,
    ChatAccessError: FakeAccessError,
    // A refusal by the instance's own rules rather than by who is asking, which
    // is what a report of a greeting is.
    ChatRuleError: class extends FakeAccessError {}
}));
vi.mock("@/lib/chat/messages", () => ({ remove }));
/** Who gets told. Mocked rather than exercised: what is worth asserting here is
 *  WHEN it is raised - the queue going from empty to not - and the sending
 *  itself is a bell, an email and a webhook away from this file. */
const alertAdmins = vi.fn(async () => undefined);
vi.mock("@/lib/notifications/admins", () => ({ alertAdmins }));

const { reportMessage, settleReport } = await import("../../src/lib/chat/reports");

const actor = { id: "ada" };

beforeEach(() => {
    vi.clearAllMocks();
    announced.clear();
    requireChannel.mockImplementation(async () => ({ mayAdminister: false }));
    findMessage.mockImplementation(async () => ({
        id: MESSAGE,
        channelId: CHANNEL,
        authorId: "bob",
        body: "**shouting** at everybody",
        deletedAt: null,
        replyToId: null,
        _count: { attachments: 0 }
    }));
    findReport.mockImplementation(async () => null);
    createReport.mockImplementation(async () => ({ id: "r1" }));
    findAttachments.mockImplementation(async () => []);
    findReportFiles.mockImplementation(async () => []);
    createReportFiles.mockImplementation(async () => ({ count: 0 }));
    deleteReportFiles.mockImplementation(async () => ({ count: 0 }));
});

describe("reporting a message", () => {
    it("proves the conversation before it takes the report", async () => {
        requireChannel.mockImplementation(async () => {
            throw new Error("not in it");
        });

        await expect(
            reportMessage(actor, { messageId: MESSAGE, reason: "spam", note: "" })
        ).rejects.toThrow();
        expect(createReport).not.toHaveBeenCalled();
    });

    it("refuses one that is already gone", async () => {
        findMessage.mockImplementation(async () => null);

        await expect(
            reportMessage(actor, { messageId: MESSAGE, reason: "spam", note: "" })
        ).rejects.toThrow();
    });

    it("copies what was said onto the report", async () => {
        await reportMessage(actor, { messageId: MESSAGE, reason: "abuse", note: "look at this" });

        const written = createReport.mock.calls[0]![0].data;
        expect(written.reason).toBe("abuse");
        expect(written.note).toBe("look at this");
        expect(written.authorId).toBe("bob");
        // The words, not the Markdown. A moderator reading a queue of asterisks
        // is reading the storage format rather than the message.
        expect(written.excerpt).toContain("shouting");
        expect(written.excerpt).not.toContain("**");
    });

    it("refuses a report of a message that is only a greeting", async () => {
        // A row a moderator can only dismiss. Enough of them and the queue stops
        // being read, which is what this protects.
        findMessage.mockImplementation(async () => ({
            id: MESSAGE,
            channelId: CHANNEL,
            authorId: "bob",
            body: "Hola!",
            deletedAt: null,
            replyToId: null,
            _count: { attachments: 0 }
        }));

        await expect(
            reportMessage(actor, { messageId: MESSAGE, reason: "spam", note: "" })
        ).rejects.toThrow(/greeting/i);
        expect(createReport).not.toHaveBeenCalled();
    });

    it("takes a report of a picture whose caption is a greeting", async () => {
        // The picture is what is being reported, and the word under it says
        // nothing about that.
        findMessage.mockImplementation(async () => ({
            id: MESSAGE,
            channelId: CHANNEL,
            authorId: "bob",
            body: "hola",
            deletedAt: null,
            replyToId: null,
            _count: { attachments: 1 }
        }));

        await reportMessage(actor, { messageId: MESSAGE, reason: "abuse", note: "" });
        expect(createReport).toHaveBeenCalled();
    });

    it("is the same report the second time somebody presses it", async () => {
        findReport.mockImplementation(async () => ({ id: "r1" }));

        const result = await reportMessage(actor, {
            messageId: MESSAGE,
            reason: "illegal",
            note: ""
        });

        expect(result.already).toBe(true);
        expect(createReport).not.toHaveBeenCalled();
        expect(updateReport).toHaveBeenCalledTimes(1);
        expect(updateReport.mock.calls[0]![0].data.reason).toBe("illegal");
        // And nobody is told again. The row it updates is already in the queue,
        // so there is no new work to announce.
        expect(alertAdmins).not.toHaveBeenCalled();
    });

    it("tells the administrators when the queue stops being empty", async () => {
        // A queue nobody is queued to is a page somebody has to remember, and
        // people do not: this was filed in silence until now.
        await reportMessage(actor, { messageId: MESSAGE, reason: "abuse", note: "" });

        expect(alertAdmins).toHaveBeenCalledTimes(1);
        expect(alertAdmins.mock.calls[0]![0]).toMatchObject({ actionRequired: true });
    });

    it("says it once, however many arrive after it", async () => {
        // The alert reaches every administrator by every route each of them has
        // left on. One per report turns a spam wave into a hundred alerts each,
        // which is the queue being used as a weapon rather than announced. The
        // badge counts the rest.
        await reportMessage(actor, { messageId: MESSAGE, reason: "spam", note: "" });
        await reportMessage(actor, { messageId: MESSAGE, reason: "spam", note: "" });
        await reportMessage(actor, { messageId: MESSAGE, reason: "spam", note: "" });

        expect(createReport).toHaveBeenCalledTimes(3);
        expect(alertAdmins).toHaveBeenCalledTimes(1);
    });

    it("says it once when two arrive at the same moment", async () => {
        // The reason it is not a count taken after the write: both of those see
        // two rows and neither says anything, so the wave nobody is watching for
        // is the one nobody is told about.
        await Promise.all([
            reportMessage(actor, { messageId: MESSAGE, reason: "spam", note: "" }),
            reportMessage(actor, { messageId: MESSAGE, reason: "spam", note: "" })
        ]);

        expect(alertAdmins).toHaveBeenCalledTimes(1);
    });

    it("lets the next report announce the queue again once it is emptied", async () => {
        await reportMessage(actor, { messageId: MESSAGE, reason: "spam", note: "" });
        expect(alertAdmins).toHaveBeenCalledTimes(1);

        findReport.mockImplementation(async () => ({
            id: "r1",
            messageId: MESSAGE,
            status: "open"
        }));
        countReports.mockImplementation(async () => 0);
        await settleReport({ id: "root" }, "r1", "kept");
        findReport.mockImplementation(async () => null);

        await reportMessage(actor, { messageId: MESSAGE, reason: "spam", note: "" });

        expect(alertAdmins).toHaveBeenCalledTimes(2);
    });
});

describe("settling one", () => {
    beforeEach(() => {
        findReport.mockImplementation(async () => ({
            id: "r1",
            messageId: MESSAGE,
            status: "open"
        }));
    });

    it("keeps the message when the answer is to keep it", async () => {
        await settleReport({ id: "root" }, "r1", "kept");

        expect(remove).not.toHaveBeenCalled();
        expect(updateReport.mock.calls[0]![0].data.status).toBe("kept");
    });

    it("deletes it on the instance's authority, not the conversation's", async () => {
        await settleReport({ id: "root" }, "r1", "removed");

        // The moderator is not in that room and never will be. What makes this
        // safe is the administrator gate on the action above it, so the flag is
        // the whole point rather than a shortcut.
        expect(remove).toHaveBeenCalledTimes(1);
        expect(remove.mock.calls[0]![2]).toEqual({ asModerator: true });
        expect(updateReport.mock.calls[0]![0].data.status).toBe("removed");
        expect(updateReport.mock.calls[0]![0].data.handledById).toBe("root");
    });

    it("still settles when the message has already gone", async () => {
        findReport.mockImplementation(async () => ({ id: "r1", messageId: null, status: "open" }));

        await settleReport({ id: "root" }, "r1", "removed");

        expect(remove).not.toHaveBeenCalled();
        expect(updateReport).toHaveBeenCalledTimes(1);
    });
});
