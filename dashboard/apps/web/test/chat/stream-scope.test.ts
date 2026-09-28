/**
 * The channels a person's live streams deliver, resolved once for all of them.
 *
 * What is pinned: several tabs open for one account resolve their reach once
 * between them rather than once each, whether the question comes from a
 * message in a room they are not in or from a membership change every tab is
 * handed at the same moment; a change that lands while a resolution is already
 * running is answered by a fresh one, not by the one that may have read the
 * rows from before it; and the shared answer goes away with the last tab.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let resolutions = 0;
let rooms = new Set(["room"]);
/** Held open by a case that wants a resolution to still be running. */
let gate: Promise<void> | null = null;

vi.mock("../../src/lib/chat/access", () => ({
    reachableChannelIds: async () => {
        resolutions += 1;
        const seen = new Set(rooms);
        if (gate) await gate;
        return seen;
    }
}));

const { heldStreamScopes, holdStreamScope } = await import("../../src/lib/chat/stream-scope");

beforeEach(() => {
    resolutions = 0;
    rooms = new Set(["room"]);
    gate = null;
});

describe("one account's streams", () => {
    it("share a resolution rather than each asking", async () => {
        const tabs = [1, 2, 3].map(() => holdStreamScope({ id: "ada" }));
        await Promise.all(tabs.map((tab) => tab.refresh()));
        expect(resolutions).toBe(1);
        for (const tab of tabs) expect(tab.reachable().has("room")).toBe(true);
        for (const tab of tabs) tab.release();
    });

    it("ask once for a change every one of them is handed", async () => {
        const tabs = [1, 2, 3].map(() => holdStreamScope({ id: "ada" }));
        await tabs[0]!.refresh();
        resolutions = 0;
        rooms = new Set(["room", "new"]);

        // What the stream does with a "channels" change: the same object, at
        // every tab, in the same tick.
        const change = { kind: "channels" };
        await Promise.all(
            tabs.map((tab) => {
                tab.invalidate(change);
                return tab.refresh();
            })
        );
        expect(resolutions).toBe(1);
        for (const tab of tabs) expect(tab.reachable().has("new")).toBe(true);
        for (const tab of tabs) tab.release();
    });

    it("asks again for a change that arrives while an older answer is being read", async () => {
        const tab = holdStreamScope({ id: "ada" });
        let open!: () => void;
        gate = new Promise((resolve) => {
            open = resolve;
        });
        // Running, and it read the rooms from before somebody added them.
        const running = tab.refresh();
        await Promise.resolve();
        gate = null;
        rooms = new Set(["room", "new"]);

        tab.invalidate({ kind: "channels" });
        const fresh = tab.refresh();
        open();
        await Promise.all([running, fresh]);

        expect(resolutions).toBe(2);
        expect(tab.reachable().has("new")).toBe(true);
        tab.release();
    });

    it("is let go of with the last tab", async () => {
        const first = holdStreamScope({ id: "grace" });
        const second = holdStreamScope({ id: "grace" });
        const before = heldStreamScopes();
        first.release();
        // Releasing twice is one release: a stream can be stopped by both the
        // abort and the cancel.
        first.release();
        expect(heldStreamScopes()).toBe(before);
        second.release();
        expect(heldStreamScopes()).toBe(before - 1);
    });
});
