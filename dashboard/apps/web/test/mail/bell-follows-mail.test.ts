/**
 * The bell's notices about a conversation go read when the conversation is
 * read, filed or thrown away - on the screen at once, and on the server in the
 * same action, so the bell's next frame does not bring the count back.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    notification: { updateMany: vi.fn() },
    mailMessage: { findMany: vi.fn() }
}));
vi.mock("@polaris/db", () => ({ prisma: db }));

import {
    readNoticesAboutMessages,
    readNoticesAboutThreads
} from "@/lib/mailbox/mail-notices";

const SCREENS = fileURLToPath(new URL("../../src/app/(app)/mail/", import.meta.url));
const COMPONENTS = fileURLToPath(new URL("../../src/components/", import.meta.url));

beforeEach(() => {
    db.notification.updateMany.mockReset().mockResolvedValue({ count: 1 });
    db.mailMessage.findMany.mockReset();
});

describe("on the server", () => {
    it("reads the unread notices that link to the conversation, for that user only", async () => {
        await readNoticesAboutThreads("user-1", ["thread-1", "thread-1", "thread-2"]);
        expect(db.notification.updateMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                readAt: null,
                href: { in: ["/mail/t/thread-1", "/mail/t/thread-2"] }
            },
            data: { readAt: expect.any(Date) }
        });
    });

    it("finds the conversations of the messages named, among the user's own", async () => {
        db.mailMessage.findMany.mockResolvedValue([{ threadId: "thread-9" }]);
        await readNoticesAboutMessages("user-1", ["message-1"]);
        expect(db.mailMessage.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: { in: ["message-1"] }, account: { userId: "user-1" } }
            })
        );
        expect(db.notification.updateMany.mock.calls[0][0].where.href).toEqual({
            in: ["/mail/t/thread-9"]
        });
    });

    it("never fails the mail action it follows", async () => {
        db.notification.updateMany.mockRejectedValue(new Error("down"));
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        await expect(readNoticesAboutThreads("user-1", ["thread-1"])).resolves.toBeUndefined();
        quiet.mockRestore();
    });

    it("asks nothing for nothing", async () => {
        await readNoticesAboutThreads("user-1", []);
        await readNoticesAboutMessages("user-1", []);
        expect(db.notification.updateMany).not.toHaveBeenCalled();
        expect(db.mailMessage.findMany).not.toHaveBeenCalled();
    });
});

describe("in the browser", () => {
    it("Mail's actions read the notices once the mail has moved", async () => {
        const actions = await readFile(`${SCREENS}actions.ts`, "utf8");
        expect(actions).toContain("if (DEALT_WITH.has(parsed.data.action)) {");
        expect(actions.match(/await readNoticesAboutMessages\(userId, parsed\.data\.messageIds\);/g))
            .toHaveLength(3);
    });

    it("the bell shows them read at once and puts them back on a refusal", async () => {
        const feed = await readFile(`${COMPONENTS}notifications/notifications-provider.tsx`, "utf8");
        expect(feed).toContain("export function useHoldConversationNotices()");
        expect(feed).toContain('setItems((rows) => applyFeedMutation(rows, { kind: "readMany", ids: held }));');
        expect(feed).toContain("held.includes(row.id) ? { ...row, read: false } : row");
        const shell = await readFile(`${SCREENS}mail-shell.tsx`, "utf8");
        expect(shell).toContain("const notices = holdNotices(threads);");
    });
});
