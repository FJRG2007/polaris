/**
 * A dropped item is looked up again as the person who dropped it.
 *
 * The payload is never believed: each kind goes through its own app's reader
 * with the caller's id, and "not there" and "not yours" are one refusal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
    can: true,
    message: null as unknown,
    stored: [] as Array<{ userId: string; name: string; mediaType: string; text: string }>,
    channel: "chan-1" as string | null,
    access: true,
    readable: true,
    chatFile: null as unknown,
    drive: null as unknown,
    readers: [] as string[]
}));

vi.mock("@/lib/session", () => ({ sessionCan: async () => calls.can }));
vi.mock("@/lib/mailbox/messages", () => ({
    messageForReading: async (userId: string) => {
        calls.readers.push(userId);
        return calls.message;
    },
    loadBody: async () => ({ text: "", html: "" })
}));
vi.mock("@/lib/chat/access", () => ({ channelAccess: async () => (calls.access ? {} : null) }));
vi.mock("@/lib/chat/history-visibility", () => ({ attachmentReadable: async () => calls.readable }));
vi.mock("@/lib/chat/attachments", () => ({
    channelOfAttachment: async () => calls.channel,
    readAttachment: async () => calls.chatFile
}));
vi.mock("@/lib/attachments/from-elsewhere", () => {
    class AttachRefused extends Error {
        constructor(
            message: string,
            readonly reason?: "too_large"
        ) {
            super(message);
        }
    }
    return {
        AttachRefused,
        fileFromDrive: async (userId: string) => {
            calls.readers.push(userId);
            if (calls.drive === "too_large") throw new AttachRefused("Too much.", "too_large");
            if (!calls.drive) throw new AttachRefused("That file is not yours to attach.");
            return calls.drive;
        }
    };
});
vi.mock("@/lib/polar/attachments", () => ({
    POLAR_ATTACHMENT_MAX_BYTES: 10 * 1024 * 1024,
    acceptedType: (type: string) => (["image/png", "text/plain"].includes(type) ? type : null),
    storePolarAttachment: async (input: {
        userId: string;
        name: string;
        mediaType: string;
        bytes: Uint8Array;
    }) => {
        calls.stored.push({ ...input, text: new TextDecoder().decode(input.bytes) });
        return { id: "a", url: "/api/polar/attachments/a", filename: input.name, mediaType: input.mediaType, size: input.bytes.byteLength };
    }
}));

import type { SessionUser } from "@/lib/session";
import { attachDroppedItem, ItemRefused, textFromHtml } from "@/lib/polar/item-attachments";

const USER = { id: "user-1" } as SessionUser;
const ID = "0192f0a4-1c2b-7d3e-8f40-1234567890ab";

beforeEach(() => {
    calls.can = true;
    calls.message = null;
    calls.stored = [];
    calls.channel = "chan-1";
    calls.access = true;
    calls.readable = true;
    calls.chatFile = null;
    calls.drive = null;
    calls.readers = [];
});

async function refusal(promise: Promise<unknown>): Promise<string | null> {
    try {
        await promise;
        return null;
    } catch (caught) {
        return caught instanceof ItemRefused ? caught.code : "other";
    }
}

describe("a dropped mail", () => {
    it("is read as the caller, and somebody else's reads as not found", async () => {
        expect(await refusal(attachDroppedItem(USER, { kind: "mail-message", id: ID }))).toBe(
            "not_found"
        );
        expect(calls.readers).toEqual(["user-1"]);
        expect(calls.stored).toHaveLength(0);
    });

    it("is attached as its headers and its text", async () => {
        calls.message = {
            envelope: {
                subject: "Invoice 4411",
                to: [{ name: "Ana", address: "ana@example.test" }],
                cc: [],
                sentAt: "2026-10-01T10:00:00.000Z"
            },
            row: {
                bodyText: null,
                bodyHtml: "<p>Please pay</p><script>x()</script><p>by Friday &amp; thanks</p>",
                fromJson: [{ name: "", address: "billing@example.test" }]
            }
        };
        const file = await attachDroppedItem(USER, { kind: "mail-message", id: ID });
        expect(file.mediaType).toBe("text/plain");
        expect(calls.stored[0]!.name).toBe("Invoice 4411.txt");
        expect(calls.stored[0]!.text).toContain("Subject: Invoice 4411");
        expect(calls.stored[0]!.text).toContain("From: billing@example.test");
        expect(calls.stored[0]!.text).toContain("To: Ana <ana@example.test>");
        expect(calls.stored[0]!.text).toContain("Please pay\nby Friday & thanks");
        expect(calls.stored[0]!.text).not.toContain("x()");
    });

    it("is refused to an account without Mail", async () => {
        calls.can = false;
        expect(await refusal(attachDroppedItem(USER, { kind: "mail-message", id: ID }))).toBe(
            "not_found"
        );
    });
});

describe("a dropped Drive file", () => {
    it("goes through the storage guard as the caller", async () => {
        expect(
            await refusal(
                attachDroppedItem(USER, { kind: "drive-file", connectionId: "nas", path: "a.png" })
            )
        ).toBe("not_found");
        expect(calls.readers).toEqual(["user-1"]);
    });

    it("says when it is too big, from the guard's reason rather than its sentence", async () => {
        calls.drive = "too_large";
        expect(
            await refusal(
                attachDroppedItem(USER, { kind: "drive-file", connectionId: "nas", path: "a.png" })
            )
        ).toBe("too_large");
    });

    it("is refused when Polar cannot read its kind", async () => {
        calls.drive = { name: "a.exe", type: "application/x-msdownload", bytes: new Uint8Array(1) };
        expect(
            await refusal(
                attachDroppedItem(USER, { kind: "drive-file", connectionId: "nas", path: "a.exe" })
            )
        ).toBe("unsupported_type");
    });
});

describe("a dropped chat picture", () => {
    it("needs the conversation", async () => {
        calls.access = false;
        calls.chatFile = { name: "p.png", contentType: "image/png", bytes: new Uint8Array(1) };
        expect(await refusal(attachDroppedItem(USER, { kind: "chat-attachment", id: ID }))).toBe(
            "not_found"
        );
        expect(calls.stored).toHaveLength(0);
    });

    it("needs the message to still be readable in its history", async () => {
        calls.readable = false;
        calls.chatFile = { name: "p.png", contentType: "image/png", bytes: new Uint8Array(1) };
        expect(await refusal(attachDroppedItem(USER, { kind: "chat-attachment", id: ID }))).toBe(
            "not_found"
        );
    });

    it("is attached when the caller can see it", async () => {
        calls.chatFile = { name: "p.png", contentType: "image/png", bytes: new Uint8Array(3) };
        const file = await attachDroppedItem(USER, { kind: "chat-attachment", id: ID });
        expect(file.mediaType).toBe("image/png");
        expect(calls.stored[0]!.userId).toBe("user-1");
    });
});

describe("mail HTML as text", () => {
    it("keeps the words and drops the markup", () => {
        expect(textFromHtml("<style>a{}</style><div>One</div><div>Two&nbsp;<b>three</b></div>")).toBe(
            "One\nTwo three"
        );
    });
});
