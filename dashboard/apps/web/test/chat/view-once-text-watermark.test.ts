/**
 * View once beyond photos: a typed message sent as a small text file, the
 * sender's watermark choice kept per file, and a recorded clip's timer.
 */

import { describe, expect, it, vi } from "vitest";

const privacy = new Map<string, { viewOnceWatermark: boolean }>();

vi.mock("@/lib/chat/attachments", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    removeStoredFiles: async () => undefined
}));
vi.mock("@/lib/chat/report-files", () => ({ keepForReports: async () => undefined }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_AUTH_SECRET: "test-secret-test-secret-test-secret" }) }));
vi.mock("@polaris/db", () => ({
    Prisma: { PrismaClientKnownRequestError: class extends Error {} },
    prisma: {
        userPrivacy: {
            findUnique: async ({ where }: { where: { userId: string } }) => privacy.get(where.userId) ?? null
        }
    }
}));

const choice = await import("@/lib/chat/view-once-choice");
const once = await import("@/lib/chat/view-once");
const { previewOf } = await import("@/lib/chat/toasts");

const bytes = (text: string) => new TextEncoder().encode(text);

describe("a view-once text", () => {
    it("is accepted only as text/plain, under the cap, in UTF-8, sent in the request", () => {
        const fits = { contentType: "text/plain", borrowed: false, inForm: bytes("hello") };
        expect(choice.viewOnceAllowed(fits)).toBe(true);
        expect(choice.viewOnceAllowed({ ...fits, contentType: "text/plain;charset=utf-8" })).toBe(true);
        // Another text type is not a message.
        expect(choice.viewOnceAllowed({ ...fits, contentType: "text/html" })).toBe(false);
        expect(choice.viewOnceAllowed({ ...fits, contentType: "application/pdf" })).toBe(false);
        // Over the cap, empty, blank, or not UTF-8.
        const big = new Uint8Array(choice.MAX_VIEW_ONCE_TEXT_BYTES + 1).fill(97);
        expect(choice.viewOnceAllowed({ ...fits, inForm: big })).toBe(false);
        expect(choice.viewOnceAllowed({ ...fits, inForm: new Uint8Array(choice.MAX_VIEW_ONCE_TEXT_BYTES).fill(97) })).toBe(true);
        expect(choice.viewOnceAllowed({ ...fits, inForm: new Uint8Array() })).toBe(false);
        expect(choice.viewOnceAllowed({ ...fits, inForm: bytes("   \n") })).toBe(false);
        expect(choice.viewOnceAllowed({ ...fits, inForm: new Uint8Array([0xc3, 0x28]) })).toBe(false);
        // Streamed, its bytes are not read here; from a Drive it is not the conversation's.
        expect(choice.viewOnceAllowed({ ...fits, inForm: null })).toBe(false);
        expect(choice.viewOnceAllowed({ ...fits, borrowed: true })).toBe(false);
    });

    it("leaves photos, videos and recordings as they were", () => {
        for (const contentType of ["image/jpeg", "video/webm", "audio/ogg"]) {
            expect(choice.viewOnceAllowed({ contentType, borrowed: false, inForm: null })).toBe(true);
        }
        expect(choice.viewOnceAllowed({ contentType: "image/png", borrowed: true, inForm: null })).toBe(false);
    });

    it("is made from typed words under one fixed name, and refused past the cap", async () => {
        const file = choice.viewOnceTextFile("  a secret  ")!;
        expect(file.name).toBe(choice.VIEW_ONCE_TEXT_NAME);
        expect(file.type).toBe("text/plain");
        expect(await file.text()).toBe("a secret");
        expect(choice.viewOnceTextFile("   ")).toBeNull();
        // Four bytes a character: 1025 of them is past 4 KiB.
        expect(choice.viewOnceTextFile("\u{1F600}".repeat(1025))).toBeNull();
        expect(choice.viewOnceTextFile("\u{1F600}".repeat(1024))).not.toBeNull();
    });
});

describe("previews", () => {
    it("never show a view-once file, text or not", () => {
        const base = { id: "a1", name: choice.VIEW_ONCE_TEXT_NAME, posterPath: null, spoiler: false };
        expect(previewOf([{ ...base, contentType: "text/plain", viewOnce: true }])).toBeNull();
        expect(previewOf([{ ...base, contentType: "image/png", viewOnce: true }])).toBeNull();
        expect(previewOf([{ ...base, contentType: "image/png", viewOnce: false }])).not.toBeNull();
    });
});

describe("the watermark", () => {
    it("is the reader and the time, or empty when the sender's snapshot is off", () => {
        const at = new Date("2027-11-28T09:30:00Z");
        expect(decodeURIComponent(once.watermarkHeader({ watermark: true }, "Ana", at))).toBe("Ana - 2027-11-28 09:30 UTC");
        expect(once.watermarkHeader({ watermark: false }, "Ana", at)).toBe("");
    });

    it("is on for a sender who never chose, and off only when they turned it off", async () => {
        privacy.clear();
        expect(await once.senderWatermark("nobody")).toBe(true);
        privacy.set("off", { viewOnceWatermark: false });
        privacy.set("on", { viewOnceWatermark: true });
        expect(await once.senderWatermark("off")).toBe(false);
        expect(await once.senderWatermark("on")).toBe(true);
    });
});
