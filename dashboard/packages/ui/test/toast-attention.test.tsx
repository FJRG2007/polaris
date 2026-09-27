// @vitest-environment jsdom

/**
 * A note waits for somebody to be able to see it.
 *
 * The report: a chime, a look at the screen, and nothing there. The note had
 * been raised while the tab was behind another window and spent its whole life
 * unseen - and a chat message never reaches the bell, so nothing anywhere said
 * what had made the sound.
 *
 * And the other way round: a window on screen that was not the one being typed
 * in held a message's note until it was closed by hand. On screen is seen.
 */

import { ToastProvider, useToast } from "../src/components/toast";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let focused = true;
let visibility: DocumentVisibilityState = "visible";

function Raise({ title }: { title: string }) {
    const toast = useToast();
    return (
        <button type="button" onClick={() => toast.show({ title })}>
            raise
        </button>
    );
}

describe("how long a note stays", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        focused = true;
        visibility = "visible";
        vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
        vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    });
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("goes after a few seconds on a tab somebody is looking at", () => {
        render(
            <ToastProvider>
                <Raise title="Ana: hello" />
            </ToastProvider>
        );
        act(() => screen.getByText("raise").click());
        act(() => void vi.advanceTimersByTime(100));
        expect(screen.queryByText("Ana: hello")).not.toBeNull();
        act(() => void vi.advanceTimersByTime(7000));
        expect(screen.queryByText("Ana: hello")).toBeNull();
    });

    it("waits while the tab is hidden, then counts from the return", () => {
        render(
            <ToastProvider>
                <Raise title="Movement at the studio" />
            </ToastProvider>
        );
        act(() => {
            visibility = "hidden";
            document.dispatchEvent(new Event("visibilitychange"));
        });
        act(() => screen.getByText("raise").click());
        act(() => void vi.advanceTimersByTime(60_000));
        expect(screen.queryByText("Movement at the studio")).not.toBeNull();

        act(() => {
            visibility = "visible";
            document.dispatchEvent(new Event("visibilitychange"));
        });
        act(() => void vi.advanceTimersByTime(3000));
        expect(screen.queryByText("Movement at the studio")).not.toBeNull();
        act(() => void vi.advanceTimersByTime(4000));
        expect(screen.queryByText("Movement at the studio")).toBeNull();
    });

    it("goes on a window that is on screen but not the one being typed in", () => {
        focused = false;
        render(
            <ToastProvider>
                <Raise title="Ana: are you there?" />
            </ToastProvider>
        );
        act(() => screen.getByText("raise").click());
        act(() => void vi.advanceTimersByTime(7000));
        expect(screen.queryByText("Ana: are you there?")).toBeNull();
    });

    it("keeps its own time when another note arrives", () => {
        render(
            <ToastProvider>
                <Raise title="First" />
            </ToastProvider>
        );
        const raise = () => screen.getByText("raise").click();
        act(raise);
        act(() => void vi.advanceTimersByTime(4000));
        act(raise);
        act(() => void vi.advanceTimersByTime(2500));
        expect(screen.getAllByText("First")).toHaveLength(1);
    });

    it("starts again when replaced under its key", () => {
        function Chat() {
            const toast = useToast();
            return (
                <>
                    <button type="button" onClick={() => toast.show({ key: "ana", title: "Ana: hello" })}>
                        first
                    </button>
                    <button type="button" onClick={() => toast.show({ key: "ana", title: "Ana: still there?" })}>
                        second
                    </button>
                </>
            );
        }
        render(
            <ToastProvider>
                <Chat />
            </ToastProvider>
        );
        act(() => screen.getByText("first").click());
        act(() => void vi.advanceTimersByTime(5900));
        act(() => screen.getByText("second").click());
        act(() => void vi.advanceTimersByTime(5000));
        expect(screen.queryByText("Ana: still there?")).not.toBeNull();
        act(() => void vi.advanceTimersByTime(1500));
        expect(screen.queryByText("Ana: still there?")).toBeNull();
    });
});
