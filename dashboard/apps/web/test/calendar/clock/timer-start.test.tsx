// @vitest-environment jsdom
/**
 * Pressing Start on a timer goes straight to Pause and stays there.
 *
 * The optimistic change used the panel's ticker, which stands still while
 * nothing counts. On a page open longer than the timer's length, the timer it
 * drew ended in the past, so the card went Start -> "Start over" (done) ->
 * Pause once the server answered.
 */

import { useState } from "react";
import "@/components/app-host/client";
import { MessagesWrapper } from "../../setup/i18n";
import type * as model from "@polaris-app/calendar/src/lib/clock/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClockRead } from "@polaris-app/calendar/src/screens/clock/store";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const pending = vi.hoisted(() => ({
    resolve: null as null | ((value: unknown) => void),
    calls: [] as unknown[]
}));

vi.mock("@polaris-app/calendar/src/actions/clock", () => ({
    changeTimerAction: (input: unknown) => {
        pending.calls.push(input);
        return new Promise((resolve) => {
            pending.resolve = resolve;
        });
    },
    createTimerAction: vi.fn(),
    startFocusAction: vi.fn(),
    editTimerAction: vi.fn(),
    sendClockCopyAction: vi.fn()
}));

vi.mock("@polaris-app/calendar/src/actions/sharing", () => ({ shareTargetsAction: vi.fn() }));

import { TimersPanel } from "@polaris-app/calendar/src/screens/clock/timers-panel";

const TIMER: model.TimerView = {
    id: "00000000-0000-4000-8000-000000000001",
    label: "Tea",
    durationMs: 60_000,
    sound: "chime",
    endsAt: null,
    remainingMs: null,
    firedAt: null,
    pomodoro: null,
    stoppedDue: null
};

function snapshotWith(timer: model.TimerView): model.ClockSnapshot {
    return {
        alarms: [],
        timers: [timer],
        stopwatch: { startedAt: null, elapsedMs: 0, laps: [] },
        serverNow: new Date().toISOString()
    };
}

function Harness() {
    const [snapshot, setSnapshot] = useState<model.ClockSnapshot | null>(() => snapshotWith(TIMER));
    const clock: ClockRead = {
        snapshot,
        skew: 0,
        error: false,
        allowed: true,
        refresh: () => undefined,
        replace: setSnapshot
    };
    return (
        <TimersPanel
            clock={clock}
            pomodoro={{ focus: 25, short: 5, long: 15, rounds: 4, auto: true }}
            onPomodoro={() => undefined}
        />
    );
}

/** The card's main button, as each render left it. */
function watchMainButton(card: HTMLElement): string[] {
    const seen: string[] = [];
    const read = () => {
        const label = within(card)
            .getAllByRole("button")
            .map((button) => button.textContent ?? "")
            .find((text) => /Start|Pause|Resume|Start over/.test(text));
        if (label !== undefined && seen[seen.length - 1] !== label) seen.push(label);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(card, { subtree: true, childList: true, characterData: true });
    return seen;
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-10-08T10:00:00Z"));
    pending.resolve = null;
    pending.calls = [];
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("starting a timer", () => {
    it("switches straight to Pause and stays there when the server answers", async () => {
        render(<Harness />, { wrapper: MessagesWrapper });
        // The page has been open for five minutes - longer than the timer -
        // with nothing counting, so the panel's ticker has not moved.
        vi.setSystemTime(new Date("2026-10-08T10:05:00Z"));
        const card = screen.getByText("Tea").closest("li")!;
        const seen = watchMainButton(card);

        await act(async () => {
            fireEvent.click(within(card).getByRole("button", { name: /^Start$/ }));
        });
        expect(pending.calls).toEqual([{ id: TIMER.id, change: "start" }]);
        expect(within(card).getByText("01:00")).toBeTruthy();

        const started = new Date("2026-10-08T10:05:00Z").getTime();
        await act(async () => {
            pending.resolve!({
                ok: true,
                snapshot: snapshotWith({
                    ...TIMER,
                    endsAt: new Date(started + 60_000).toISOString()
                })
            });
        });

        // Flush MutationObserver callbacks.
        await act(async () => undefined);
        expect(seen).toEqual(["Start", "Pause"]);
        expect(within(card).queryByText(/Done/)).toBeNull();
    });
});
