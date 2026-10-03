// @vitest-environment jsdom

/**
 * The Time area's four tabs, drawn the way the real screen draws them: the
 * alarms, timers, stopwatch and world-clock panels read from a snapshot the
 * server answered, not from a view model built for the test.
 *
 * The tab itself lives in the URL (`?tab=`), not in component state, so each
 * tab is reached by rendering with that query already set - the same thing a
 * direct link or the header's indicator does - rather than by simulating a
 * click through a router mock that does not really navigate.
 */

import "@/components/app-host/client";
import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClockSnapshot } from "@polaris-app/calendar/src/lib/clock/model";
import type { TimeTab } from "@polaris-app/calendar/src/screens/clock/time-view";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
    DEFAULT_PREFERENCES,
    type CalendarPreferences
} from "@polaris-app/calendar/src/lib/preferences";

let preferences: CalendarPreferences = DEFAULT_PREFERENCES;
let tab: TimeTab = "alarms";
const replaced: string[] = [];

const snapshot: ClockSnapshot = {
    alarms: [
        {
            id: "alarm-1",
            time: "07:00",
            days: 0b0111110,
            label: "Gym",
            sound: "chime",
            snoozeMinutes: 10,
            enabled: true,
            zone: "America/New_York",
            nextFireAt: "2026-10-05T11:00:00.000Z",
            snoozed: false
        },
        {
            id: "alarm-2",
            time: "22:30",
            days: 0,
            label: "Lights out",
            sound: "bell",
            snoozeMinutes: 10,
            enabled: false,
            zone: "America/New_York",
            nextFireAt: null,
            snoozed: false
        }
    ],
    timers: [
        {
            id: "timer-1",
            label: "Pasta",
            durationMs: 10 * 60_000,
            sound: "chime",
            endsAt: null,
            remainingMs: 4 * 60_000 + 30_000,
            firedAt: null,
            pomodoro: null
        },
        {
            id: "timer-2",
            label: "",
            durationMs: 25 * 60_000,
            sound: "digital",
            endsAt: null,
            remainingMs: 12 * 60_000,
            firedAt: null,
            pomodoro: { focus: 25, short: 5, long: 15, rounds: 4, auto: true, phase: "focus", round: 2, done: 1 }
        }
    ],
    stopwatch: {
        startedAt: null,
        elapsedMs: 5 * 60_000 + 23_000,
        laps: [45_000, 92_000, 150_000]
    },
    serverNow: "2026-10-03T12:00:00.000Z"
};

vi.mock("next/navigation", () => ({
    useRouter: () => ({
        push: vi.fn(),
        replace: (url: string) => replaced.push(url),
        refresh: vi.fn()
    }),
    usePathname: () => "/calendar/time",
    useSearchParams: () => new URLSearchParams(tab === "alarms" ? "" : `tab=${tab}`)
}));

vi.mock("@polaris-app/calendar/src/actions/preferences", () => ({
    loadPreferencesAction: async () => ({ ok: true, preferences }),
    savePreferencesAction: async (patch: Partial<CalendarPreferences>) => {
        preferences = { ...preferences, ...patch };
        return { ok: true, preferences };
    }
}));

vi.mock("@polaris-app/calendar/src/actions/clock", () => ({
    loadClockAction: async () => ({ ok: true, snapshot }),
    saveAlarmAction: async () => ({ ok: true, snapshot }),
    changeAlarmAction: async () => ({ ok: true, snapshot }),
    createTimerAction: async () => ({ ok: true, snapshot }),
    startFocusAction: async () => ({ ok: true, snapshot }),
    changeTimerAction: async () => ({ ok: true, snapshot }),
    changeStopwatchAction: async () => ({ ok: true, snapshot })
}));

// Imported after the mocks it depends on are declared (vi.mock is hoisted anyway).
const { TimeView } = await import("@polaris-app/calendar/src/screens/clock/time-view");

async function settle(): Promise<void> {
    await act(async () => {
        for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });
}

beforeEach(() => {
    tab = "alarms";
    replaced.length = 0;
    preferences = { ...DEFAULT_PREFERENCES, timezone: "America/New_York", worldClock: ["Europe/Madrid", "Asia/Tokyo"] };
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 200, headers: { "content-type": "application/json" } }))
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("the Time area's tabs", () => {
    it("draws the alarms list from the server's snapshot", async () => {
        render(<TimeView />, { wrapper: MessagesWrapper });
        await settle();
        screen.getByText("Alarms");
        screen.getByText("07:00");
        screen.getByText(/Gym/);
        screen.getByText("22:30");
    });

    it("sends the chosen tab into the address instead of keeping it in state", async () => {
        render(<TimeView />, { wrapper: MessagesWrapper });
        await settle();
        fireEvent.click(screen.getByText("Timers & focus"));
        expect(replaced).toEqual(["/calendar/time?tab=timers"]);
    });

    it("draws the timers tab with a plain timer and a focus cycle", async () => {
        tab = "timers";
        render(<TimeView />, { wrapper: MessagesWrapper });
        await settle();
        screen.getByText("Pasta");
        screen.getByText(/Round 2 of 4/);
    });

    it("draws the stopwatch tab with its kept laps", async () => {
        tab = "stopwatch";
        render(<TimeView />, { wrapper: MessagesWrapper });
        await settle();
        screen.getByText("05:23.00");
        expect(screen.getAllByRole("row")).toHaveLength(4); // header + 3 laps
    });

    it("draws the world clock tab with its saved cities and the meeting planner", async () => {
        tab = "world";
        render(<TimeView />, { wrapper: MessagesWrapper });
        await settle();
        // Each saved city shows twice: in the list and as the planner's own column.
        expect(screen.getAllByText("Madrid").length).toBeGreaterThan(0);
        expect(screen.getAllByText("Tokyo").length).toBeGreaterThan(0);
        screen.getByText("Meeting planner");
    });
});
