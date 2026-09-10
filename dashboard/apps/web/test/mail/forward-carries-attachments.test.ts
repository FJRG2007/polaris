/**
 * A forward carries the files of the message it forwards.
 *
 * The commonest way forwarding fails somebody is the invoice that was the whole
 * point of the forward not arriving with it. This pins the three things the
 * carry-over must get right: it only reaches files on a message the reader owns
 * (the ownership is part of the query, not a check after it), it leaves behind
 * the pictures the HTML draws by Content-Id, and a file that is too big or cannot
 * be fetched is named rather than failing the others.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface AttachmentRow {
    id: string;
    name: string;
    size: bigint;
}

let rows: AttachmentRow[] = [];
let lastWhere: unknown = null;
const stored: string[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        mailAttachment: {
            findMany: async (query: { where: unknown }) => {
                lastWhere = query.where;
                return rows;
            }
        }
    }
}));

vi.mock("@/lib/mailbox/messages", () => ({
    readAttachment: async (_userId: string, attachmentId: string) => {
        if (attachmentId === "broken") throw new Error("the mail server hung up");
        return {
            name: `${attachmentId}.pdf`,
            contentType: "application/pdf",
            bytes: Buffer.from("x")
        };
    }
}));

vi.mock("@/lib/mailbox/uploads", () => ({
    MAX_ATTACHMENT_BYTES: 1000,
    storeUpload: async (_userId: string, file: { name: string }) => {
        stored.push(file.name);
        return {
            id: `u-${file.name}`,
            name: file.name,
            size: 1,
            contentType: "",
            inline: false,
            contentId: ""
        };
    }
}));

vi.mock("@/lib/attachments/from-elsewhere", () => ({
    AttachRefused: class extends Error {},
    fileFromAddress: async () => null,
    fileFromDrive: async () => null
}));

const { attachFromMessage } = await import("@/lib/mailbox/attach-from");

beforeEach(() => {
    rows = [];
    lastWhere = null;
    stored.length = 0;
});

describe("carrying a forwarded message's files", () => {
    it("asks only for the reader's own message, and not for its inline pictures", async () => {
        await attachFromMessage("u1", "m1");
        expect(lastWhere).toEqual({
            messageId: "m1",
            inline: false,
            message: { account: { userId: "u1" } }
        });
    });

    it("keeps every file it could fetch as a pending upload", async () => {
        rows = [
            { id: "invoice", name: "invoice.pdf", size: 10n },
            { id: "contract", name: "contract.pdf", size: 10n }
        ];
        const outcome = await attachFromMessage("u1", "m1");
        expect(outcome.uploads.map((one) => one.name)).toEqual(["invoice.pdf", "contract.pdf"]);
        expect(outcome.skipped).toEqual([]);
    });

    it("names a file that is too big or cannot be fetched, and still carries the rest", async () => {
        rows = [
            { id: "huge", name: "video.mov", size: 5000n },
            { id: "broken", name: "scan.pdf", size: 10n },
            { id: "invoice", name: "invoice.pdf", size: 10n }
        ];
        const outcome = await attachFromMessage("u1", "m1");
        expect(outcome.skipped).toEqual(["video.mov", "scan.pdf"]);
        expect(stored).toEqual(["invoice.pdf"]);
    });
});
