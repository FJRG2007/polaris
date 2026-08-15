/**
 * Pictures somebody kept.
 *
 * Two things are load-bearing and both are about the id arriving from a browser.
 *
 * An attachment id is a request, not a permission: without a check against the
 * conversation it is in, anybody could keep - and then re-send into a room of
 * their own - a picture from a channel they have never been in. And a stored one
 * is COPIED when it is sent again rather than pointed at, because a second row
 * sharing a path means deleting either message takes the picture out of both.
 * That second one is a bug that only appears when somebody tidies up, which is
 * exactly the sort that ships.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    userId: string;
    source: string;
    name: string;
}

let rows: Row[] = [];
let reachable = new Set<string>(["channel-mine"]);
let sent: { channelId: string; attachments: unknown[] }[] = [];
let stored: { channelId: string; name: string }[] = [];
let read: string[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        chatSavedMedia: {
            count: async ({ where }: { where: { userId: string } }) =>
                rows.filter((row) => row.userId === where.userId).length,
            findUnique: async ({ where }: { where: { userId_source: Row } }) =>
                rows.find(
                    (row) =>
                        row.userId === where.userId_source.userId &&
                        row.source === where.userId_source.source
                ) ?? null,
            findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
                rows.find((row) => row.id === where.id && row.userId === where.userId) ?? null,
            findMany: async ({ where }: { where: { userId: string; source?: { in: string[] } } }) =>
                rows.filter(
                    (row) =>
                        row.userId === where.userId &&
                        (!where.source || where.source.in.includes(row.source))
                ),
            create: async ({ data }: { data: Omit<Row, "id"> }) => {
                const row = { id: `saved-${rows.length + 1}`, ...data };
                rows.push(row);
                return row;
            },
            deleteMany: async ({ where }: { where: { userId: string; source: string } }) => {
                rows = rows.filter(
                    (row) => !(row.userId === where.userId && row.source === where.source)
                );
                return { count: 1 };
            }
        },
        chatAttachment: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                where.id === "gone"
                    ? null
                    : { message: { channelId: where.id === "theirs" ? "channel-theirs" : "channel-mine" } }
        }
    }
}));

vi.mock("@/lib/chat/access", async () => {
    const { ChatAccessError } = await vi.importActual<typeof import("@/lib/chat/access")>(
        "@/lib/chat/access"
    );
    return {
        ChatAccessError,
        requireChannel: async (_actor: unknown, channelId: string) => {
            if (!reachable.has(channelId)) throw new ChatAccessError("Not yours");
            return { spaceId: null, mayAdminister: false };
        },
        requirePostable: async (_actor: unknown, channelId: string) => {
            if (!reachable.has(channelId)) throw new ChatAccessError("Not yours");
        }
    };
});

vi.mock("@/lib/chat/attachments", () => ({
    readAttachment: async (id: string) => {
        read.push(id);
        return { name: "cat.gif", contentType: "image/gif", bytes: new Uint8Array([1, 2, 3]) };
    },
    storeAttachment: async (channelId: string, file: { name: string }) => {
        stored.push({ channelId, name: file.name });
        return { name: file.name, size: 3, contentType: "image/gif", connectionId: null, path: "p" };
    }
}));

vi.mock("@/lib/chat/messages", () => ({
    send: async (
        _actor: unknown,
        input: { channelId: string },
        attachments: unknown[]
    ) => {
        sent.push({ channelId: input.channelId, attachments });
        return "message-1";
    }
}));

const saved = await import("@/lib/chat/saved-media");

const ada = { id: "ada" };

beforeEach(() => {
    rows = [];
    sent = [];
    stored = [];
    read = [];
    reachable = new Set(["channel-mine"]);
});

describe("keeping one", () => {
    it("keeps a picture from a conversation the reader is in", async () => {
        const kept = await saved.saveMedia(ada, "attachment:abc", "cat.gif");
        expect(kept.source).toBe("attachment:abc");
        expect(kept.src).toBe("/api/chat/attachments/abc");
    });

    it("refuses one from a conversation they are not in", async () => {
        // The whole reason this is checked: an attachment id in a request is a
        // guess until the channel behind it says otherwise.
        await expect(saved.saveMedia(ada, "attachment:theirs")).rejects.toThrow(/not yours/i);
    });

    it("refuses one that is gone", async () => {
        await expect(saved.saveMedia(ada, "attachment:gone")).rejects.toThrow(/gone/i);
    });

    it("keeps a web address", async () => {
        const kept = await saved.saveMedia(ada, "https://media.example/cat.gif");
        expect(kept.src).toBe("https://media.example/cat.gif");
    });

    it("refuses a scheme that is a payload rather than an address", async () => {
        for (const bad of ["javascript:alert(1)", "data:image/gif;base64,AAAA", "not a url", ""]) {
            await expect(saved.saveMedia(ada, bad)).rejects.toThrow();
        }
    });

    it("is not an error to keep the same thing twice", async () => {
        // Somebody pressing a star they could not tell was already on.
        const first = await saved.saveMedia(ada, "attachment:abc");
        const again = await saved.saveMedia(ada, "attachment:abc");
        expect(again.id).toBe(first.id);
        expect(rows).toHaveLength(1);
    });
});

describe("sending one again", () => {
    it("copies a stored picture rather than pointing at the same file", async () => {
        // A second row sharing the path would mean deleting either message takes
        // the picture out of both.
        await saved.saveMedia(ada, "attachment:abc");
        const result = await saved.sendSavedMedia(ada, "channel-mine", "saved-1");
        expect(read).toEqual(["abc"]);
        expect(stored).toEqual([{ channelId: "channel-mine", name: "cat.gif" }]);
        expect(result).toEqual({ messageId: "message-1" });
    });

    it("hands a web address back to be fetched through the ordinary guard", async () => {
        // Checked at the moment it is used rather than trusted because it was
        // once seen in a message.
        await saved.saveMedia(ada, "https://media.example/cat.gif");
        expect(await saved.sendSavedMedia(ada, "channel-mine", "saved-1")).toEqual({
            remote: "https://media.example/cat.gif"
        });
        expect(sent).toEqual([]);
    });

    it("refuses one that is not theirs", async () => {
        rows = [{ id: "saved-9", userId: "grace", source: "attachment:abc", name: "" }];
        await expect(saved.sendSavedMedia(ada, "channel-mine", "saved-9")).rejects.toThrow(
            /not one of yours/i
        );
    });

    it("refuses a conversation they cannot post in", async () => {
        await saved.saveMedia(ada, "attachment:abc");
        await expect(saved.sendSavedMedia(ada, "channel-theirs", "saved-1")).rejects.toThrow();
    });
});

describe("reading them back", () => {
    it("says which of a list are kept, in one question", async () => {
        await saved.saveMedia(ada, "attachment:abc");
        const found = await saved.savedSources(ada, ["attachment:abc", "attachment:other"]);
        expect([...found]).toEqual(["attachment:abc"]);
    });

    it("stops keeping one", async () => {
        await saved.saveMedia(ada, "attachment:abc");
        await saved.unsaveMedia(ada, "attachment:abc");
        expect(await saved.listSavedMedia(ada)).toEqual([]);
    });
});
