// @vitest-environment jsdom

/**
 * The Events tab, used the way an operator would: it draws before the server
 * answers, lists what can be run, runs one, and will not run one from settings
 * that are not saved yet - and the editor says what is wrong beside the field.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const started: string[] = [];
let answerRead: (value: unknown) => void = () => undefined;

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

const config = {
    ...catalog.defaultEventsConfig(),
    presets: [catalog.newPreset("fishing", "fish"), catalog.newPreset("mining-rush", "rush")]
};
const view = {
    config,
    run: null,
    history: [
        {
            id: "h1",
            presetId: "fish",
            kind: "fishing",
            name: "Fishing contest",
            trigger: "random",
            outcome: "finished",
            note: "Ran its full time",
            startedAt: Date.parse("2026-09-27T20:00:00Z"),
            endedAt: Date.parse("2026-09-27T20:10:00Z"),
            participants: 4,
            podium: [{ place: 1, name: "Ana", score: 6 }],
            disqualified: []
        }
    ],
    pending: [],
    nextRandomAt: null,
    waiting: null,
    players: { online: 3, active: 2 },
    refusal: null
};

vi.mock("@polaris-app/game-servers/src/screens/installed/events-actions", () => ({
    readEventsAction: () =>
        new Promise((resolve) => {
            answerRead = resolve;
        }),
    saveEventsAction: async () => ({ view }),
    startEventAction: async (input: { presetId: string }) => {
        started.push(input.presetId);
        return { view };
    },
    cancelEventAction: async () => ({ view }),
    forgetPrizeAction: async () => ({ view })
}));

const { MinecraftEvents } = await import(
    "@polaris-app/game-servers/src/screens/installed/minecraft-events"
);

afterEach(() => {
    cleanup();
    started.length = 0;
});

describe("the Events tab", () => {
    it("explains an event from its row", async () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({ view });
        await waitFor(() => expect(screen.getByLabelText("What Fishing contest is")).toBeTruthy());
        expect(screen.queryByText(/Most catches with a fishing rod wins/)).toBeNull();
        fireEvent.click(screen.getByLabelText("What Fishing contest is"));
        expect(screen.getByText(/Most catches with a fishing rod wins/)).toBeTruthy();
        expect(screen.getByText(/Ranked from 3 catches/)).toBeTruthy();
        expect(screen.getByText(/Prizes - 1st: 5 diamond, 15 levels/)).toBeTruthy();
    });

    it("draws its sections before the server answers", () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        expect(screen.getByText("Now")).toBeTruthy();
        expect(screen.getByText("Events")).toBeTruthy();
        expect(screen.getByText("Automatic events")).toBeTruthy();
        expect(screen.getByText("History")).toBeTruthy();
        expect(screen.queryByText("Fishing contest")).toBeNull();
    });

    it("lists the events, the players and the history once it answers, and runs one", async () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({ view });
        await waitFor(() => expect(screen.getByLabelText("Run Fishing contest now")).toBeTruthy());
        expect(screen.getByText(/3 on the server, 2 of them playing/)).toBeTruthy();
        expect(screen.getByText("1. Ana (6)")).toBeTruthy();
        fireEvent.click(screen.getByLabelText("Run Fishing contest now"));
        await waitFor(() => expect(started).toEqual(["fish"]));
    });

    it("will not run an event from changes that are not saved", async () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({ view });
        await waitFor(() => expect(screen.getByLabelText("Run Fishing contest now")).toBeTruthy());
        fireEvent.click(screen.getByLabelText("Fishing contest can come round on its own"));
        await waitFor(() => expect(screen.getByText("Unsaved changes.")).toBeTruthy());
        expect(
            (screen.getByLabelText("Run Fishing contest now") as HTMLButtonElement).disabled
        ).toBe(true);
    });

    it("says what is wrong in the editor beside the field, and holds Done", async () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({ view });
        await waitFor(() => expect(screen.getByLabelText("Edit Fishing contest")).toBeTruthy());
        fireEvent.click(screen.getByLabelText("Edit Fishing contest"));
        const name = await screen.findByDisplayValue("Fishing contest");
        fireEvent.change(name, { target: { value: "  " } });
        await waitFor(() =>
            expect(screen.getAllByText("Give it a name").length).toBeGreaterThan(0)
        );
        expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(true);
        fireEvent.change(name, { target: { value: "Friday fishing" } });
        await waitFor(() =>
            expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(false)
        );
    });

    it("lets somebody without the grant look but not change anything", async () => {
        render(
            <MinecraftEvents
                installedAppId="00000000-0000-4000-8000-000000000001"
                canManage={false}
            />
        );
        answerRead({ view });
        await waitFor(() => expect(screen.getByLabelText("Run Fishing contest now")).toBeTruthy());
        expect(
            (screen.getByLabelText("Run Fishing contest now") as HTMLButtonElement).disabled
        ).toBe(true);
        expect((screen.getByLabelText("Edit Fishing contest") as HTMLButtonElement).disabled).toBe(
            true
        );
    });
});
