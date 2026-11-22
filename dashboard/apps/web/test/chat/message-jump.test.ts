/**
 * Following a link to one message lands on it, however old, and says why only
 * when the server says there is nothing to land on.
 *
 * The case that made this: a notice tapped for a message that had just arrived.
 * The conversation opened on the copy this device kept, which predates it; the
 * jump looked there, found nothing and said the message was out of reach - and
 * then the server's page arrived and drew the message under the error.
 */

import { describe, expect, it, vi } from "vitest";
import type { ChatAroundPage } from "@/lib/chat/messages";
import { jumpToMessage, type FoundWindow, type JumpSteps } from "@/app/(app)/chat/jump";

/** A screen whose window is a list of ids, and steps that act on it. */
function screen(initial: string[], around: (id: string) => ChatAroundPage | { error: string }) {
    const state = { window: [...initial], threads: [] as string[] };
    let freshDone: () => void = () => undefined;
    const freshRead = new Promise<void>((resolve) => {
        freshDone = resolve;
    });
    const readAround = vi.fn(async (id: string) => {
        const answer = around(id);
        return "error" in answer ? { error: answer.error } : { page: answer };
    });
    const steps: JumpSteps = {
        fresh: () => freshRead,
        drawn: async () => undefined,
        landOn: (id) => state.window.includes(id),
        readAround,
        showWindow: (page: FoundWindow) => {
            state.window = page.messages.map((message) => message.id);
        },
        openThread: async (id) => {
            state.threads.push(id);
            return true;
        }
    };
    return { state, steps, readAround, arrive: (ids: string[]) => ((state.window = ids), freshDone()) };
}

function found(ids: string[]): ChatAroundPage {
    return {
        found: true,
        messages: ids.map((id) => ({ id }) as FoundWindow["messages"][number]),
        olderThan: ids[0] ?? null,
        newerThan: null
    };
}

describe("a link to a message", () => {
    it("waits for the server's page when the kept copy predates the message", async () => {
        const view = screen(["m1", "m2"], () => ({ found: false, reason: "missing" }));
        const jump = jumpToMessage("m3", view.steps);
        // The fresh page is still on its way: nothing has been decided yet.
        await Promise.resolve();
        expect(view.readAround).not.toHaveBeenCalled();
        view.arrive(["m1", "m2", "m3"]);
        expect(await jump).toEqual({ kind: "landed" });
        expect(view.readAround).not.toHaveBeenCalled();
    });

    it("still lands when the fresh read fails", async () => {
        const view = screen(["m1"], () => found(["m0", "m1"]));
        view.steps = { ...view.steps, fresh: () => Promise.reject(new Error("offline")) };
        expect(await jumpToMessage("m0", view.steps)).toEqual({ kind: "landed" });
    });

    it("swaps to the window around a message far outside the one on screen", async () => {
        const view = screen([], (id) => found(["old-1", id, "old-3"]));
        view.arrive(["new-1", "new-2"]);
        expect(await jumpToMessage("old-2", view.steps)).toEqual({ kind: "landed" });
        expect(view.state.window).toEqual(["old-1", "old-2", "old-3"]);
        expect(view.readAround).toHaveBeenCalledTimes(1);
    });

    it("opens the thread a reply lives in", async () => {
        const view = screen([], () => ({ found: false, reason: "reply" }));
        view.arrive(["m1"]);
        expect(await jumpToMessage("r1", view.steps)).toEqual({ kind: "thread" });
        expect(view.state.threads).toEqual(["r1"]);
    });

    it.each(["deleted", "unreadable", "missing"] as const)("says why: %s", async (reason) => {
        const view = screen([], () => ({ found: false, reason }));
        view.arrive(["m1"]);
        expect(await jumpToMessage("x", view.steps)).toEqual({ kind: "missing", reason });
    });

    it("hands back the server's own sentence when the read is refused", async () => {
        const view = screen([], () => ({ error: "You are not in that conversation" }));
        view.arrive([]);
        expect(await jumpToMessage("x", view.steps)).toEqual({
            kind: "failed",
            error: "You are not in that conversation"
        });
    });
});
