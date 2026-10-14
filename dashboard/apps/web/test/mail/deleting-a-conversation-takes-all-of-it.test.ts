/**
 * Deleting a conversation from the list deletes all of it from that folder.
 *
 * The list names a conversation by its newest message in the folder, and a move
 * used to take that message alone. A conversation of three in the inbox lost its
 * newest to Trash, kept the other two, and the next list - or a reload - put the
 * row straight back: "I deleted it and it came back".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { sameFolderSiblings } from "@/lib/mailbox/folder-scope";

interface Row {
    id: string;
    uid: bigint;
    accountId: string;
    folderId: string;
    threadId: string;
    messageId: string;
    seen: boolean;
    flagged: boolean;
}

const INBOX = "folder-inbox";
const SENT = "folder-sent";
const TRASH = "folder-trash";

function row(id: string, uid: number, folderId: string, threadId = "thread-1"): Row {
    return {
        id,
        uid: BigInt(uid),
        accountId: "account-1",
        folderId,
        threadId,
        messageId: `<${id}@example.test>`,
        seen: false,
        flagged: false
    };
}

const mailbox: Row[] = [
    row("newest", 30, INBOX),
    row("middle", 20, INBOX),
    row("oldest", 10, INBOX),
    row("reply-sent", 5, SENT),
    row("other", 40, INBOX, "thread-2")
];

const moves: { path: string; uids: number[]; to: string }[] = [];
let refuse = false;

vi.mock("next/server", () => ({ after: (run: () => unknown) => void run() }));
vi.mock("@polaris/db", () => ({
    prisma: {
        mailFolder: {
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
                path: where.id === INBOX ? "INBOX" : where.id === SENT ? "Sent" : "Trash",
                role: where.id === INBOX ? "inbox" : ""
            })),
            findFirst: vi.fn(async () => ({ id: TRASH, accountId: "account-1", path: "Trash" }))
        },
        mailMessage: { deleteMany: vi.fn(async () => ({ count: 0 })) }
    }
}));
vi.mock("@/lib/mailbox/access", () => ({
    ACCOUNT_COLUMNS: {},
    MailAccessError: class extends Error {},
    ownedAccount: vi.fn(async () => ({ id: "account-1" })),
    ownedMessages: vi.fn(async (_user: string, ids: readonly string[]) =>
        mailbox.filter((one) => ids.includes(one.id))
    ),
    ownedThreadMessages: vi.fn(async (_user: string, threads: readonly string[]) =>
        mailbox.filter((one) => threads.includes(one.threadId))
    )
}));
vi.mock("@/lib/mailbox/imap", () => ({
    withImap: async (_account: unknown, run: (client: unknown) => Promise<unknown>) => {
        let open = "";
        return await run({
            getMailboxLock: async (path: string) => {
                open = path;
                return { release: () => undefined };
            },
            messageMove: async (uids: number[], to: string) => {
                if (refuse) return false;
                moves.push({ path: open, uids: [...uids].sort((a, b) => a - b), to });
                return { path: open, destination: to };
            }
        });
    }
}));
vi.mock("@/lib/mailbox/folder-roles", () => ({
    folderForRole: vi.fn(async () => ({ id: TRASH, path: "Trash" }))
}));
vi.mock("@/lib/mailbox/trash", () => ({
    forgetTrashOrigins: vi.fn(),
    rememberTrashOrigins: vi.fn(),
    restoreFromTrash: vi.fn(async () => 0)
}));
vi.mock("@/lib/mailbox/sync", () => ({
    catchUpFolder: vi.fn(async () => undefined),
    refreshThreads: vi.fn(async () => undefined)
}));
vi.mock("@/lib/mailbox/live", () => ({ publishMail: vi.fn() }));
vi.mock("@/lib/mailbox/spam", () => ({ teachSpam: vi.fn() }));
vi.mock("@/lib/mailbox/folder-counts", () => ({
    addDelta: vi.fn(),
    nudgeFolderUnread: vi.fn(async () => undefined),
    unseenByFolder: () => new Map()
}));

const { actOnMessages, moveMessages } = await import("@/lib/mailbox/messages");

beforeEach(() => {
    moves.length = 0;
    refuse = false;
});

describe("a conversation row moved out of its folder", () => {
    it("takes every message of it in that folder, and nothing elsewhere", async () => {
        const done = await actOnMessages("user-1", ["newest"], "trash", { scope: "folder" });
        expect(done).toBe(3);
        expect(moves).toEqual([{ path: "INBOX", uids: [10, 20, 30], to: "Trash" }]);
    });

    it("still takes only the message named when asked for a message", async () => {
        await actOnMessages("user-1", ["newest"], "trash", { scope: "message" });
        expect(moves).toEqual([{ path: "INBOX", uids: [30], to: "Trash" }]);
    });

    it("does the same for a drop onto a folder", async () => {
        await moveMessages("user-1", ["newest"], TRASH, { scope: "folder", strict: true });
        expect(moves).toEqual([{ path: "INBOX", uids: [10, 20, 30], to: "Trash" }]);
    });

    it("says so when the server refuses a drop, rather than answering done", async () => {
        refuse = true;
        await expect(
            moveMessages("user-1", ["newest"], TRASH, { scope: "folder", strict: true })
        ).rejects.toThrow(/refused/);
    });
});

describe("sameFolderSiblings", () => {
    it("keeps each message once and leaves other folders and conversations out", () => {
        const named = mailbox.filter((one) => one.id === "newest");
        const ids = sameFolderSiblings(named, mailbox).map((one) => one.id);
        expect(ids.sort()).toEqual(["middle", "newest", "oldest"]);
    });
});
