// @vitest-environment jsdom
/**
 * The pill beside the bell while a timer or the stopwatch runs.
 *
 * It counts every second, and its hover text must not: a browser hides a
 * tooltip whose text changes and shows it again, so a label carrying the
 * countdown blinked once a second and could not be read.
 */

import "@/components/app-host/client";
import { MessagesWrapper } from "../../setup/i18n";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    timers: [] as unknown[],
    watchStartedAt: null as string | null
}));

vi.mock("next/link", () => ({
    default: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>
}));

vi.mock("@polaris-app/calendar/src/screens/clock/ringer", () => ({
    useRinger: () => ({ rings: [] }),
    RingDialog: () => null
}));

vi.mock("@polaris-app/calendar/src/screens/clock/store", async (original) => ({
    ...(await original<object>()),
    useClock: () => ({
        allowed: true,
        skew: 0,
        refresh: () => undefined,
        snapshot: {
            alarms: [],
            timers: state.timers,
            stopwatch: { startedAt: state.watchStartedAt, elapsedMs: 0, laps: null },
            serverNow: new Date().toISOString()
        }
    })
}));

import { TimeIndicator } from "@polaris-app/calendar/src/screens/clock/time-indicator";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-10-08T10:00:00Z"));
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    state.timers = [];
    state.watchStartedAt = null;
});

describe("the running-timer pill", () => {
    it("keeps the same hover text while the countdown moves", () => {
        state.timers = [
            {
                id: "t1",
                label: "Tea",
                pomodoro: null,
                durationMs: 300_000,
                endsAt: "2026-10-08T10:05:00Z",
                remainingMs: null,
                firedAt: null
            }
        ];
        render(<TimeIndicator />, { wrapper: MessagesWrapper });
        const pill = screen.getByRole("link");
        const hover = pill.getAttribute("title");
        expect(hover).toContain("Tea");
        expect(pill.textContent).toContain("05:00");

        act(() => void vi.advanceTimersByTime(3000));
        expect(pill.textContent).toContain("04:57");
        expect(pill.getAttribute("title")).toBe(hover);
        expect(screen.getByRole("link", { name: /04:57/ })).toBe(pill);
    });

    it("keeps the same hover text while the stopwatch runs", () => {
        state.watchStartedAt = "2026-10-08T09:59:50Z";
        render(<TimeIndicator />, { wrapper: MessagesWrapper });
        const pill = screen.getByRole("link");
        const hover = pill.getAttribute("title");
        act(() => void vi.advanceTimersByTime(2000));
        expect(pill.textContent).toContain("00:12");
        expect(screen.getByRole("link", { name: /00:12/ })).toBe(pill);
        expect(pill.getAttribute("title")).toBe(hover);
    });
});
