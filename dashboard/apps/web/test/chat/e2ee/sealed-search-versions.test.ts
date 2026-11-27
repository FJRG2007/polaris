/**
 * A shared segment can name a message at a version an edit has since moved
 * past. Search opens the message as it stands, and what it keeps - the hit it
 * answers, this device's own index, and the opened content - must be that
 * version with its own edit time, never the newer words under the older
 * time: the launcher shows only an entry at the version the server lists
 * (`sealed-lookup.ts`), so the old time hid the hit.
 */

import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";

const CHANNEL = "0192f5a0-0000-7000-8000-00000000c001";
const MESSAGE = "0192f5a0-0000-7000-8000-000000000001";
const BEFORE = "2026-11-20T10:00:00.000Z";
const AFTER = "2026-11-21T09:30:00.000Z";

const state = vi.hoisted(() => ({ reads: [] as string[][], encode: null as ((content: { body: string }) => Uint8Array) | null }));

vi.mock("@/lib/chat/e2ee/account-key-client", () => ({ deviceAccountHpke: async () => null }));
vi.mock("@/lib/chat/e2ee/mls-browser", () => ({
    browserDeviceId: (userId: string) => `device-of-${userId}`,
    openBrowserDevice: async () => ({
        readSealed: async (_channelId: string, ids: string[]) => {
            state.reads.push(ids);
            // The message as it stands: edited again after the segment named it.
            return ids.map((id) => ({ id, authorId: "a", sender: "a/d", epoch: 5n, revision: 2, editedAt: AFTER, opened: state.encode!({ body: "the invoice, corrected" }) }));
        }
    })
}));
vi.mock("@/lib/chat/e2ee/search-segments-client", () => ({
    pageSearchHost: () => ({}),
    buildSegments: async () => 0,
    SegmentReader: class {
        refresh = async () => undefined;
        clear = async () => undefined;
        // The segment was built before the last edit.
        search = async () => [{ id: MESSAGE, channelId: CHANNEL, editedAt: BEFORE }];
    }
}));

const sealed = await import("@/lib/chat/e2ee/sealed-chat");
state.encode = sealed.encodeSealedContent;

describe("a search hit opened at a newer version than its segment named", () => {
    it("is kept under the version that opened, so the launcher still shows it", async () => {
        sealed.configureSealedChat("11111111-1111-4111-8111-111111111111");
        const found = await sealed.searchSealedEntries("invoice", null, 10);
        expect(found).toEqual([{ id: MESSAGE, channelId: CHANNEL, editedAt: AFTER, body: "the invoice, corrected" }]);
        expect(state.reads).toEqual([[MESSAGE]]);

        // This device's own index now holds it, at that version: the next search answers from there.
        await vi.waitFor(async () => {
            const again = await sealed.searchSealedEntries("corrected", null, 10);
            expect(again).toMatchObject([{ id: MESSAGE, channelId: CHANNEL, editedAt: AFTER, body: "the invoice, corrected" }]);
        });

        // The opened content is kept under the version it is: asked for at that version it is not read again.
        const reads = state.reads.length;
        expect((await sealed.openSealed(CHANNEL, [{ id: MESSAGE, editedAt: AFTER }])).get(MESSAGE)).toEqual({ body: "the invoice, corrected" });
        expect(state.reads).toHaveLength(reads);
        // Asked for at the older one, it is read again rather than answered with the newer words under the older time.
        await sealed.openSealed(CHANNEL, [{ id: MESSAGE, editedAt: BEFORE }]);
        expect(state.reads).toHaveLength(reads + 1);
        sealed.configureSealedChat(null);
    });
});
