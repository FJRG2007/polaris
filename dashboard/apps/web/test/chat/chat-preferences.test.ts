/**
 * Chat's per-account settings: an account with no row reads the defaults (the
 * caption above its pictures, as Discord draws it), a broken or foreign value
 * reads as the default instead of failing, a wrong value is refused on write,
 * and a change that changes nothing writes nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => new Map<string, string>());
const upsert = vi.hoisted(() => vi.fn());

vi.mock("@polaris/db", () => ({
    prisma: {
        chatPreference: {
            findUnique: async ({ where }: { where: { userId: string } }) =>
                rows.has(where.userId) ? { value: rows.get(where.userId)! } : null,
            upsert: async (args: { where: { userId: string }; create: { value: string } }) => {
                upsert(args);
                rows.set(args.where.userId, args.create.value);
            }
        }
    }
}));

const schema = await import("@/lib/chat/preference-schema");
const prefs = await import("@/lib/chat/preferences");

beforeEach(() => {
    rows.clear();
    upsert.mockClear();
});

describe("reading chat preferences", () => {
    it("defaults to the caption above the pictures", () => {
        expect(schema.DEFAULT_CHAT_PREFERENCES).toEqual({ captionPosition: "above" });
        expect(schema.readChatPreferences(undefined)).toEqual({ captionPosition: "above" });
        expect(schema.readChatPreferences("{}")).toEqual({ captionPosition: "above" });
    });

    it("reads a broken or unknown value as the default", () => {
        expect(schema.readChatPreferences("not json")).toEqual({ captionPosition: "above" });
        expect(schema.readChatPreferences('{"captionPosition":"side"}')).toEqual({
            captionPosition: "above"
        });
        expect(schema.readChatPreferences(42)).toEqual({ captionPosition: "above" });
    });

    it("reads a stored choice, as text or already parsed", () => {
        expect(schema.readChatPreferences('{"captionPosition":"below"}')).toEqual({
            captionPosition: "below"
        });
        expect(schema.readChatPreferences({ captionPosition: "below" })).toEqual({
            captionPosition: "below"
        });
    });

    it("refuses a wrong value on write", () => {
        expect(schema.chatPreferencesSchema.safeParse({ captionPosition: "side" }).success).toBe(
            false
        );
    });
});

describe("where the caption goes", () => {
    const image = { contentType: "image/png" };
    const video = { contentType: "video/mp4" };
    const pdf = { contentType: "application/pdf" };

    it("goes below only for a reader who chose it, with text and a picture", () => {
        expect(schema.captionGoesBelow("below", { body: "hi", attachments: [image] })).toBe(true);
        expect(schema.captionGoesBelow("below", { body: "hi", attachments: [pdf, video] })).toBe(
            true
        );
        expect(schema.captionGoesBelow("above", { body: "hi", attachments: [image] })).toBe(false);
    });

    it("stays where it is with no text or nothing visual", () => {
        expect(schema.captionGoesBelow("below", { body: "  ", attachments: [image] })).toBe(false);
        expect(schema.captionGoesBelow("below", { body: "hi", attachments: [pdf] })).toBe(false);
        expect(schema.captionGoesBelow("below", { body: "hi", attachments: [] })).toBe(false);
    });
});

describe("saving chat preferences", () => {
    it("loads the defaults for an account with no row", async () => {
        expect(await prefs.loadChatPreferences("u1")).toEqual({ captionPosition: "above" });
    });

    it("stores a change and reads it back", async () => {
        expect(await prefs.saveChatPreferences("u1", { captionPosition: "below" })).toEqual({
            captionPosition: "below"
        });
        expect(upsert).toHaveBeenCalledTimes(1);
        expect(await prefs.loadChatPreferences("u1")).toEqual({ captionPosition: "below" });
        expect(await prefs.loadChatPreferences("u2")).toEqual({ captionPosition: "above" });
    });

    it("writes nothing for a change that changes nothing", async () => {
        await prefs.saveChatPreferences("u1", { captionPosition: "above" });
        expect(upsert).not.toHaveBeenCalled();
    });

    it("refuses a wrong value", async () => {
        await expect(
            prefs.saveChatPreferences("u1", { captionPosition: "side" as "above" })
        ).rejects.toThrow();
        expect(upsert).not.toHaveBeenCalled();
    });
});
