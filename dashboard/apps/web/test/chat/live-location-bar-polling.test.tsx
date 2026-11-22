// @vitest-environment jsdom
/**
 * The live-location bar above the conversation list reads the running shares
 * again once a minute, so one started on another device shows up. Only while
 * the tab is on screen: it used to ask from every tab, hidden or not, all day.
 */

import { MessagesWrapper } from "../setup/i18n";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ asked: 0 }));

vi.mock("@/app/(app)/chat/actions", () => ({
    liveSharesAction: async () => {
        state.asked += 1;
        return { shares: [] };
    },
    stopLiveSharesAction: async () => ({})
}));
vi.mock("@/app/(app)/chat/chat-context", () => ({ useChat: () => ({ channels: [] }) }));

const { LiveLocationBar, SHARES_RECHECK_MS } = await import("@/app/(app)/chat/live-location-bar");

function setVisibility(value: DocumentVisibilityState): void {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
    state.asked = 0;
    vi.useFakeTimers();
});
afterEach(() => {
    cleanup();
    setVisibility("visible");
    vi.useRealTimers();
});

describe("the live-location bar", () => {
    it("asks nothing while the tab is hidden, and once on return", async () => {
        render(<LiveLocationBar />, { wrapper: MessagesWrapper });
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(state.asked).toBe(1);

        setVisibility("hidden");
        await act(() => vi.advanceTimersByTimeAsync(149 * 60_000));
        expect(state.asked).toBe(1);

        await act(async () => {
            setVisibility("visible");
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(state.asked).toBe(2);
    });

    it("still reads again once a minute while it is on screen", async () => {
        render(<LiveLocationBar />, { wrapper: MessagesWrapper });
        await act(() => vi.advanceTimersByTimeAsync(10 * SHARES_RECHECK_MS));
        expect(state.asked).toBe(11);
    });
});
