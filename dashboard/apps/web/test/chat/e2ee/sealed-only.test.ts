/**
 * A sealed conversation takes only sealed writes: once its MLS group exists, a
 * send, an edit or a scheduled message in the clear is refused with a sentence
 * the screen can show, and nothing is refused while sealed chat is off or the
 * conversation has no group.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ groups: new Set<string>(), cut: new Set<string>() }));

vi.mock("@polaris/db", () => ({
    Prisma: { DbNull: null },
    prisma: {
        mlsGroup: {
            count: async ({ where }: { where: { channelId: string } }) => (state.groups.has(where.channelId) ? 1 : 0)
        },
        chatMigration: {
            count: async ({ where }: { where: { channelId: string; state: string } }) => (where.state === "cut" && state.cut.has(where.channelId) ? 1 : 0)
        }
    }
}));

import { conversationSealed } from "@/lib/chat/e2ee/sealed-conversation";
import { refusalForPage, refusePlainIfSealed } from "@/lib/chat/messages";
import { ChatRuleError } from "@/lib/chat/access";

const SEALED = "sealed-channel";
const PLAIN = "plain-channel";

describe("sealed only", () => {
    beforeEach(() => {
        state.groups = new Set([SEALED]);
        state.cut = new Set();
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "1";
    });
    afterEach(() => {
        delete process.env.POLARIS_INTERNAL_CHAT_E2EE;
    });

    it("refuses a plain write into a conversation with a group, with the screen's key", async () => {
        expect(await conversationSealed(SEALED)).toBe(true);
        await expect(refusePlainIfSealed(SEALED)).rejects.toMatchObject({ message: expect.any(String) });
        const refusal = await refusePlainIfSealed(SEALED).catch((caught: unknown) => caught);
        expect(JSON.stringify(refusal)).toContain("errors.sealedOnly");
    });

    it("refuses a plain write into a conversation the migration cut before any group exists", async () => {
        state.cut = new Set([PLAIN]);
        expect(await conversationSealed(PLAIN)).toBe(true);
        await expect(refusePlainIfSealed(PLAIN)).rejects.toBeInstanceOf(ChatRuleError);
    });

    it("takes a plain write into a conversation that has no group", async () => {
        expect(await conversationSealed(PLAIN)).toBe(false);
        await expect(refusePlainIfSealed(PLAIN)).resolves.toBeUndefined();
    });

    it("tells a page that does not seal to reload, and one that seals what it cannot send yet", async () => {
        const refused = (pageSeals: boolean) =>
            refusalForPage(pageSeals, () => refusePlainIfSealed(SEALED)).catch((caught: unknown) => caught);
        expect(await refused(false)).toMatchObject({ text: { key: "errors.sealedOnlyReload" } });
        expect(await refused(true)).toMatchObject({ text: { key: "errors.sealedOnly" } });
        expect(await refused(false)).toBeInstanceOf(ChatRuleError);
    });

    it("leaves every other refusal and an answer as they were", async () => {
        const other = new ChatRuleError({ key: "errors.notInConversation" });
        await expect(refusalForPage(false, async () => { throw other; })).rejects.toBe(other);
        await expect(refusalForPage(false, async () => "id")).resolves.toBe("id");
        await expect(refusalForPage(false, () => refusePlainIfSealed(PLAIN))).resolves.toBeUndefined();
    });

    it("keeps refusing plain writes into a sealed conversation while held, and takes them elsewhere", async () => {
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "0";
        expect(await conversationSealed(SEALED)).toBe(true);
        await expect(refusePlainIfSealed(SEALED)).rejects.toBeInstanceOf(ChatRuleError);
        expect(await conversationSealed(PLAIN)).toBe(false);
    });

    it("refuses nothing while sealed chat is off", async () => {
        delete process.env.POLARIS_INTERNAL_CHAT_E2EE;
        expect(await conversationSealed(SEALED)).toBe(false);
        await expect(refusePlainIfSealed(SEALED)).resolves.toBeUndefined();
    });
});
