/**
 * A sealed conversation takes only sealed writes: once its MLS group exists, a
 * send, an edit or a scheduled message in the clear is refused with a sentence
 * the screen can show, and nothing is refused while sealed chat is off or the
 * conversation has no group.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ groups: new Set<string>() }));

vi.mock("@polaris/db", () => ({
    Prisma: { DbNull: null },
    prisma: {
        mlsGroup: {
            count: async ({ where }: { where: { channelId: string } }) => (state.groups.has(where.channelId) ? 1 : 0)
        }
    }
}));

import { conversationSealed } from "@/lib/chat/e2ee/sealed-conversation";
import { refusePlainIfSealed } from "@/lib/chat/messages";

const SEALED = "sealed-channel";
const PLAIN = "plain-channel";

describe("sealed only", () => {
    beforeEach(() => {
        state.groups = new Set([SEALED]);
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

    it("takes a plain write into a conversation that has no group", async () => {
        expect(await conversationSealed(PLAIN)).toBe(false);
        await expect(refusePlainIfSealed(PLAIN)).resolves.toBeUndefined();
    });

    it("refuses nothing while sealed chat is off", async () => {
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "0";
        expect(await conversationSealed(SEALED)).toBe(false);
        await expect(refusePlainIfSealed(SEALED)).resolves.toBeUndefined();
    });
});
