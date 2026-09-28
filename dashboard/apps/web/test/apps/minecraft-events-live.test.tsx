// @vitest-environment jsdom

/**
 * The Events tab keeps itself current while an event runs: the countdown turns
 * into the time left, the standings move, and when it ends it leaves "Now" and
 * lands in the history - without a reload.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@polaris/app-host/client", () => ({
    hostUi: {
        confirmDialog: { useConfirm: () => [async () => true, null] },
        displayFormat: {
            useDisplayFormat: () => ({ dateTime: (at: number) => new Date(at).toISOString() })
        },
        snapshotCache: {
            readSnapshot: () => null,
            writeSnapshot: () => undefined,
            dropSnapshots: () => undefined
        }
    }
}));

const catalog = await import("@polaris-app/game-servers/src/lib/minecraft/events/catalog");

const NOW = Date.parse("2026-09-28T19:19:00Z");
const moon = { ...catalog.newPreset("blood-moon", "moon"), name: "Blood moon" };
const config = { ...catalog.defaultEventsConfig(), presets: [moon] };
const base = {
    config,
    run: null,
    history: [] as unknown[],
    pending: [],
    nextRandomAt: null,
    waiting: null,
    players: { online: 1, active: 1 },
    refusal: null
};
const running = (phase: "countdown" | "running") => ({
    ...base,
    run: {
        presetId: "moon",
        name: "Blood moon",
        kind: "blood-moon",
        phase,
        startsAt: NOW + 60_000,
        endsAt: NOW + 11 * 60_000,
        trigger: "manual",
        cancelling: false,
        standings: phase === "running" ? [{ name: "Ana", score: 4 }] : []
    }
});
const finished = {
    ...base,
    history: [
        {
            id: "h1",
            presetId: "moon",
            kind: "blood-moon",
            name: "Blood moon",
            trigger: "manual",
            outcome: "finished",
            note: "Ran its full time",
            startedAt: NOW + 60_000,
            endedAt: NOW + 11 * 60_000,
            participants: 1,
            podium: [],
            disqualified: []
        }
    ]
};

/** What the server answers, in order; the last one repeats. */
let answers: unknown[] = [];
const reads = vi.fn(async () => ({ view: answers.length > 1 ? answers.shift() : answers[0] }));

vi.mock("@polaris-app/game-servers/src/screens/installed/events-actions", () => ({
    readEventsAction: () => reads(),
    saveEventsAction: async () => ({ view: base }),
    startEventAction: async () => ({ view: running("countdown") }),
    cancelEventAction: async () => ({ view: base }),
    forgetPrizeAction: async () => ({ view: base })
}));

const { MinecraftEvents } = await import(
    "@polaris-app/game-servers/src/screens/installed/minecraft-events"
);

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

async function tick(ms: number): Promise<void> {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

describe("the Events tab while an event runs", () => {
    it("follows it from the countdown to the history without a reload", async () => {
        vi.useFakeTimers({ now: NOW });
        answers = [base];
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        await tick(10);
        expect(screen.getByText(/No event is on/)).toBeTruthy();

        answers = [running("countdown")];
        fireEvent.click(screen.getByLabelText("Run Blood moon now"));
        await tick(10);
        expect(screen.getByText(/starts in 1:00/)).toBeTruthy();

        // The countdown runs out and the server says it has begun.
        answers = [running("running")];
        await tick(61_000);
        expect(screen.getByText(/left/)).toBeTruthy();
        expect(screen.getByText("Ana")).toBeTruthy();

        // It ends: out of Now, into the history.
        answers = [finished];
        await tick(6_000);
        expect(screen.getByText(/No event is on/)).toBeTruthy();
        expect(screen.getByText("Ran its full time")).toBeTruthy();
        // And the line said when it was started is gone with it.
        expect(screen.queryByText(/is starting/)).toBeNull();
    });
});
