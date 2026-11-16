// @vitest-environment jsdom
/**
 * The Code workspace wakes its preview and diffs on a named edit at once, and
 * on any other finished tool only when the checkout's fingerprint moved - a
 * shell command that wrote a file, not one that only read. Fixture data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const state = { print: "1.10", reads: 0 };

vi.mock("@/components/agents/sessions/sessions-polls", () => ({
    sessionChanges: async () => {
        state.reads++;
        return {
            answer: {
                kind: "listing",
                listing: { kind: "ok", base: "b", total: 0, files: [], next: null, print: state.print }
            }
        };
    }
}));

const { useCheckoutWake, PRINT_SETTLE_MS } = await import("@/components/polar/use-checkout-wake");

type Props = { lastEdit: string | null; lastTool: string | null };

function mount(initial: Props) {
    return renderHook(
        (props: Props) => useCheckoutWake({ sessionId: "s-1", active: true, ...props }),
        { initialProps: initial }
    );
}

/** Lets the settle timer fire and the read it starts answer. */
async function settle() {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(PRINT_SETTLE_MS + 10);
    });
}

describe("useCheckoutWake", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        state.print = "1.10";
        state.reads = 0;
    });
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it("wakes when a shell command changed the checkout", async () => {
        const hook = mount({ lastEdit: null, lastTool: "t0" });
        await settle();
        const before = hook.result.current;
        state.print = "2.20";
        hook.rerender({ lastEdit: null, lastTool: "t1" });
        await settle();
        expect(hook.result.current).not.toBe(before);
        expect(hook.result.current).toBe("print:2.20");
    });

    it("stays put when a tool finished without writing", async () => {
        const hook = mount({ lastEdit: null, lastTool: "t0" });
        await settle();
        const before = hook.result.current;
        hook.rerender({ lastEdit: null, lastTool: "t1" });
        await settle();
        expect(state.reads).toBeGreaterThanOrEqual(2);
        expect(hook.result.current).toBe(before);
    });

    it("wakes at once on a named edit, and the shell command after it is not a second write", async () => {
        const hook = mount({ lastEdit: null, lastTool: null });
        await settle();
        state.print = "3.30";
        hook.rerender({ lastEdit: "e1", lastTool: null });
        expect(hook.result.current).toBe("edit:e1");
        await settle();
        hook.rerender({ lastEdit: "e1", lastTool: "t1" });
        await settle();
        expect(hook.result.current).toBe("edit:e1");
    });
});
