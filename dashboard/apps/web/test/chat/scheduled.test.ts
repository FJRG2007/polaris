/**
 * Messages written now and sent later.
 *
 * Three rules with teeth, and each of them fails silently if it is wrong.
 *
 * A scheduled message is checked twice - when it is written and again when it
 * goes - because the hours in between are exactly when somebody is timed out or
 * taken out of a room. A message that lands from somebody who was shown the door
 * is worse than one that never arrives.
 *
 * It is sent once. The row is deleted as part of sending, so even a lost lease
 * cannot produce a second copy; a sweep that marked instead of deleted would
 * depend on that mark being written, which is the half that fails.
 *
 * And one that cannot be sent is kept and marked rather than dropped. The person
 * who wrote it is entitled to their words and to the reason, and it is not
 * retried - a refusal retried every minute for a year is not a feature.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    channelId: string;
    authorId: string;
    body: string;
    parentId: string | null;
    replyToId: string | null;
    forwarded: boolean;
    sendAt: Date;
    failure: string | null;
    failedAt: Date | null;
    files: {
        name: string;
        size: bigint;
        contentType: string;
        connectionId: string | null;
        path: string;
        durationMs: number | null;
        waveform: string | null;
    }[];
}

let rows: Row[] = [];
/** What `send` did, and what it was told to refuse. */
let sent: { channelId: string; body: string; attachments: number }[] = [];
let refuse: string | null = null;
/** Who may post where, as the access layer answers it. */
let postable = true;
/** Files handed to the storage sweep. */
let removed: string[] = [];

class FakeAccessError extends Error {}

vi.mock("@/lib/chat/access", () => ({
    ChatAccessError: FakeAccessError,
    requirePostable: async () => {
        if (!postable) throw new FakeAccessError("You are not in that conversation");
        return { channelId: "c1", mayPost: true };
    }
}));

vi.mock("@/lib/chat/messages", () => ({
    send: async (
        _actor: { id: string },
        input: { channelId: string; body: string },
        attachments: readonly unknown[]
    ) => {
        if (refuse) throw new FakeAccessError(refuse);
        sent.push({ channelId: input.channelId, body: input.body, attachments: attachments.length });
        return "m1";
    }
}));

vi.mock("@/lib/chat/attachments", () => ({
    removeStoredFiles: async (files: readonly { path: string }[]) => {
        removed.push(...files.map((file) => file.path));
    }
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatScheduledMessage: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
                const row: Row = {
                    id: `s${rows.length + 1}`,
                    channelId: String(data.channelId),
                    authorId: String(data.authorId),
                    body: String(data.body),
                    parentId: (data.parentId as string | null) ?? null,
                    replyToId: (data.replyToId as string | null) ?? null,
                    forwarded: Boolean(data.forwarded),
                    sendAt: data.sendAt as Date,
                    failure: null,
                    failedAt: null,
                    files: ((data.files as { create: Row["files"] } | undefined)?.create ?? []).map(
                        (file) => ({ ...file })
                    )
                };
                rows.push(row);
                return { id: row.id };
            },
            findMany: async ({ where }: { where?: Record<string, unknown> }) => {
                const due = (where?.sendAt as { lte?: Date } | undefined)?.lte;
                return rows.filter((row) => {
                    if (where && "failedAt" in where && where.failedAt === null && row.failedAt) {
                        return false;
                    }
                    if (due && row.sendAt.getTime() > due.getTime()) return false;
                    if (where?.authorId && where.authorId !== row.authorId) return false;
                    if (where?.channelId && where.channelId !== row.channelId) return false;
                    return true;
                });
            },
            findFirst: async ({ where }: { where: { id: string; authorId: string } }) =>
                rows.find((row) => row.id === where.id && row.authorId === where.authorId) ?? null,
            delete: async ({ where }: { where: { id: string } }) => {
                rows = rows.filter((row) => row.id !== where.id);
                return {};
            },
            update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
                const row = rows.find((entry) => entry.id === where.id);
                if (row) {
                    row.failure = (data.failure as string | null) ?? null;
                    row.failedAt = (data.failedAt as Date | null) ?? null;
                }
                return {};
            },
            count: async () => rows.length
        }
    }
}));

const { cancelScheduled, scheduleMessage, sweepDueScheduledMessages } = await import(
    "@/lib/chat/scheduled"
);

const ME = { id: "ada" };
const IN_AN_HOUR = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

function file(path: string) {
    return {
        name: "clip.webm",
        size: 10,
        contentType: "video/webm",
        connectionId: null,
        path,
        durationMs: null,
        waveform: null
    };
}

beforeEach(() => {
    rows = [];
    sent = [];
    removed = [];
    refuse = null;
    postable = true;
});

describe("writing one down", () => {
    it("keeps what it was told, files and all", async () => {
        const id = await scheduleMessage(
            ME,
            { channelId: "c1", body: "morning", forwarded: false, sendAt: IN_AN_HOUR() },
            [file("chat/c1/one.webm")]
        );
        expect(id).toBe("s1");
        expect(rows[0]?.body).toBe("morning");
        expect(rows[0]?.files).toHaveLength(1);
    });

    it("refuses a moment that has already been, and one a year out", async () => {
        await expect(
            scheduleMessage(ME, {
                channelId: "c1",
                body: "morning",
                forwarded: false,
                sendAt: new Date(Date.now() - 1000).toISOString()
            })
        ).rejects.toThrow(/at least a minute/);

        await expect(
            scheduleMessage(ME, {
                channelId: "c1",
                body: "morning",
                forwarded: false,
                sendAt: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString()
            })
        ).rejects.toThrow(/within the next year/);
    });

    it("refuses somebody who may not post there", async () => {
        postable = false;
        await expect(
            scheduleMessage(ME, {
                channelId: "c1",
                body: "morning",
                forwarded: false,
                sendAt: IN_AN_HOUR()
            })
        ).rejects.toThrow(/not in that conversation/);
        expect(rows).toHaveLength(0);
    });

    it("refuses one that is neither words nor files", async () => {
        await expect(
            scheduleMessage(ME, { channelId: "c1", body: "   ", forwarded: false, sendAt: IN_AN_HOUR() })
        ).rejects.toThrow(/Write something/);
    });
});

describe("the hour coming round", () => {
    it("sends what is due and leaves what is not", async () => {
        await scheduleMessage(ME, {
            channelId: "c1",
            body: "later",
            forwarded: false,
            sendAt: IN_AN_HOUR()
        });
        // Written straight into the table, since scheduling refuses the past on
        // purpose and this is the state the sweep actually meets.
        rows[0]!.sendAt = new Date(Date.now() - 1000);
        await scheduleMessage(ME, {
            channelId: "c1",
            body: "much later",
            forwarded: false,
            sendAt: IN_AN_HOUR()
        });

        const result = await sweepDueScheduledMessages();
        expect(result).toEqual({ sent: 1, failed: 0 });
        expect(sent).toEqual([{ channelId: "c1", body: "later", attachments: 0 }]);
        // The row is gone rather than marked, which is what makes a second pass
        // over the same message impossible.
        expect(rows.map((row) => row.body)).toEqual(["much later"]);
    });

    it("carries the files it was holding into the message", async () => {
        await scheduleMessage(
            ME,
            { channelId: "c1", body: "", forwarded: false, sendAt: IN_AN_HOUR() },
            [file("chat/c1/one.webm"), file("chat/c1/two.webm")]
        );
        rows[0]!.sendAt = new Date(Date.now() - 1000);

        await sweepDueScheduledMessages();
        expect(sent[0]?.attachments).toBe(2);
        // A message that is only files still needs a body, and the files are not
        // swept: they belong to the message now.
        expect(sent[0]?.body).toBe(" ");
        expect(removed).toEqual([]);
    });

    it("keeps one it could not send, says why, and does not try again", async () => {
        await scheduleMessage(ME, {
            channelId: "c1",
            body: "too late",
            forwarded: false,
            sendAt: IN_AN_HOUR()
        });
        rows[0]!.sendAt = new Date(Date.now() - 1000);
        refuse = "You are not in that conversation";

        expect(await sweepDueScheduledMessages()).toEqual({ sent: 0, failed: 1 });
        expect(rows[0]?.failure).toBe("You are not in that conversation");
        expect(rows[0]?.failedAt).not.toBeNull();

        // The second pass leaves it alone: a refusal retried every minute for a
        // year is not a feature.
        refuse = null;
        expect(await sweepDueScheduledMessages()).toEqual({ sent: 0, failed: 0 });
        expect(sent).toEqual([]);
    });
});

describe("taking one back", () => {
    it("takes the files with it", async () => {
        await scheduleMessage(
            ME,
            { channelId: "c1", body: "", forwarded: false, sendAt: IN_AN_HOUR() },
            [file("chat/c1/one.webm")]
        );
        await cancelScheduled(ME, "s1");
        expect(rows).toHaveLength(0);
        expect(removed).toEqual(["chat/c1/one.webm"]);
    });

    it("does nothing at all for somebody else's", async () => {
        await scheduleMessage(ME, {
            channelId: "c1",
            body: "mine",
            forwarded: false,
            sendAt: IN_AN_HOUR()
        });
        await cancelScheduled({ id: "eve" }, "s1");
        expect(rows).toHaveLength(1);
        expect(removed).toEqual([]);
    });
});
