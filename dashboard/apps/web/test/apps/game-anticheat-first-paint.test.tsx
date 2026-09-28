// @vitest-environment jsdom

/**
 * The Anti-cheat tab draws itself before the server has answered.
 *
 * Reading it goes into the container for every player's stats file and the
 * player list, which takes seconds. The headings, the explanations and the
 * engine's own card do not depend on that answer, so they are on screen at once
 * and only the values and the tables wait - and the engine's card asks for its
 * state in the same moment instead of after the reading.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

let answerXray: (value: unknown) => void = () => undefined;
const engineAsked = vi.fn();
const written = vi.fn();
let kept: { value: unknown; at: number } | null = null;

vi.mock("@polaris/app-host/client", async () => {
    const { useLayoutEffect } = await import("react");
    return {
        hostUi: {
            liveRead: {
                useKeptSnapshot: (
                    _key: string,
                    _maxAgeMs: number,
                    apply: (value: unknown) => void
                ) =>
                    useLayoutEffect(() => {
                        if (kept) apply(kept);
                    }, [])
            },
            snapshotCache: {
                readSnapshot: () => null,
                writeSnapshot: written,
                dropSnapshots: () => undefined
            },
            structuralMerge: { mergeUnchanged: <T,>(_previous: T, next: T) => next },
            confirmDialog: { useConfirm: () => [async () => true, null] },
            displayFormat: { useDisplayFormat: () => ({ dateTime: (at: number) => String(at) }) }
        }
    };
});
vi.mock("@polaris-app/game-servers/src/screens/installed/xray-actions", () => ({
    readXrayAction: () =>
        new Promise((resolve) => {
            answerXray = resolve;
        }),
    saveXraySettingsAction: async () => ({}),
    clearXrayPlayerAction: async () => ({})
}));
vi.mock("@polaris-app/game-servers/src/screens/installed/anticheat-engine-actions", () => ({
    anticheatStateAction: () => {
        engineAsked();
        return new Promise(() => undefined);
    },
    setAnticheatAction: async () => ({})
}));

const { MinecraftXray } = await import(
    "@polaris-app/game-servers/src/screens/installed/minecraft-xray"
);
const { DEFAULT_XRAY_SETTINGS } = await import("@polaris-app/game-servers/src/lib/minecraft/xray");

afterEach(() => {
    cleanup();
    kept = null;
    written.mockClear();
});

const VIEW = {
    settings: DEFAULT_XRAY_SETTINGS,
    traps: { overworld: 0, nether: 0 },
    players: [],
    mining: [],
    online: [],
    movement: [],
    teleportCheck: null,
    refusal: null,
    engine: []
};

describe("the Anti-cheat tab before the server answers", () => {
    it("shows every section and asks for the engine's state at the same time", () => {
        render(<MinecraftXray installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        expect(screen.getByText("Polaris anti-cheat")).toBeTruthy();
        expect(screen.getByText("Anti X-Ray")).toBeTruthy();
        expect(screen.getAllByText("Flying and teleporting").length).toBeGreaterThan(0);
        expect(screen.getByText("How likely each player is cheating")).toBeTruthy();
        expect(screen.getByText("Incidents")).toBeTruthy();
        expect(engineAsked).toHaveBeenCalledTimes(1);
        // No switch shows a value that has not been read yet.
        expect(screen.queryByLabelText("Hide honeypots")).toBeNull();
        expect(screen.queryByText("Nothing has happened in the last 14 days.")).toBeNull();
    });

    it("fills the values in once it answers", async () => {
        render(<MinecraftXray installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerXray({
            view: {
                settings: DEFAULT_XRAY_SETTINGS,
                traps: { overworld: 0, nether: 0 },
                players: [],
                mining: [],
                online: [],
                movement: [],
                teleportCheck: null,
                refusal: null,
                engine: []
            }
        });
        await waitFor(() => expect(screen.getByLabelText("Hide honeypots")).toBeTruthy());
        expect(screen.getByText("Nothing has happened in the last 14 days.")).toBeTruthy();
    });

    it("says the reading failed instead of loading forever", async () => {
        render(<MinecraftXray installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerXray({ error: "The server is not running" });
        await waitFor(() => expect(screen.getByText("The server is not running")).toBeTruthy());
        expect(screen.getByText("The incidents could not be read.")).toBeTruthy();
        expect(screen.getByText("Anti X-Ray")).toBeTruthy();
    });

    it("drops the kept view when the first read fails, and never writes it back", async () => {
        kept = { value: VIEW, at: 0 };
        render(<MinecraftXray installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        expect(screen.getByLabelText("Hide honeypots")).toBeTruthy();
        answerXray({ error: "The server is not running" });
        await waitFor(() => expect(screen.getByText("The server is not running")).toBeTruthy());
        expect(screen.getByText("The incidents could not be read.")).toBeTruthy();
        expect(screen.queryByLabelText("Hide honeypots")).toBeNull();
        expect(written).not.toHaveBeenCalled();
    });

    it("keeps the view only once this visit's read has answered", async () => {
        kept = { value: VIEW, at: 0 };
        render(<MinecraftXray installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        expect(written).not.toHaveBeenCalled();
        answerXray({ view: VIEW });
        await waitFor(() => expect(written).toHaveBeenCalled());
    });
});
