// @vitest-environment jsdom

/**
 * A note waits for somebody to be able to see it.
 *
 * The report: a chime, a look at the screen, and nothing there. The note had
 * been raised while the tab was behind another window and spent its whole life
 * unseen - and a chat message never reaches the bell, so nothing anywhere said
 * what had made the sound.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "../src/components/toast";

let focused = true;

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
        vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
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

    it("waits while the window is behind another one, then counts from the return", () => {
        render(
            <ToastProvider>
                <Raise title="Movement at the studio" />
            </ToastProvider>
        );
        act(() => {
            focused = false;
            window.dispatchEvent(new Event("blur"));
        });
        act(() => screen.getByText("raise").click());
        act(() => void vi.advanceTimersByTime(60_000));
        expect(screen.queryByText("Movement at the studio")).not.toBeNull();

        act(() => {
            focused = true;
            window.dispatchEvent(new Event("focus"));
        });
        act(() => void vi.advanceTimersByTime(3000));
        expect(screen.queryByText("Movement at the studio")).not.toBeNull();
        act(() => void vi.advanceTimersByTime(4000));
        expect(screen.queryByText("Movement at the studio")).toBeNull();
    });
});
