// @vitest-environment jsdom

/**
 * Watching the recognizer come up.
 *
 * Installing it writes the pairing at once and the container then spends a minute
 * or two pulling itself down and loading its models, so the card is drawn as
 * "Starting" before it is drawn as "Running". Nothing announces the moment it
 * starts answering - which left the card spinning until somebody reloaded the
 * page and found it had been running the whole time.
 *
 * Both directions are pinned: it asks again while it is starting, and it stops
 * asking once it answers. The second half matters as much as the first - the
 * question is a request to whichever machine it was installed on.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeSettingsView } from "@/app/(app)/places/settings/settings-view";

let answering = false;
let enabled = true;
let asked = 0;

vi.mock("@/app/(app)/places/actions", () => ({
    homeSettingsAction: async () => {
        asked += 1;
        return {
            settings: {
                faceEnabled: enabled,
                faceRunning: true,
                faceApiUrl: "",
                hasFaceKey: false,
                recognizerReady: true,
                installedOn: "this server",
                answering
            }
        };
    },
    detectionDefaultsAction: async () => ({
        defaults: { sensitivity: 50, settleSeconds: 2, minGapSeconds: 30 }
    }),
    listServersAction: async () => ({ servers: [{ id: "local", label: "this server" }] }),
    installRecognizerAction: async () => ({}),
    setFaceRecognitionAction: async () => ({}),
    setFaceEnabledAction: async () => ({}),
    setDetectionDefaultsAction: async () => ({})
}));

/** Let the effects that fetch on mount settle before anything is asserted. */
async function painted(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    answering = false;
    enabled = true;
    asked = 0;
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("a house that has recognition switched off", () => {
    it("says so, and says the container is still up", async () => {
        // Watching one come up is only a question for a house that wants it.
        // Off with a container still running is the state a house that installed
        // one before there was a switch wakes up in, and it is worth saying.
        enabled = false;
        render(<HomeSettingsView storage="this server" canAdmin />);
        await painted();
        expect(screen.getByText("Off, but still running on this server.")).toBeDefined();
    });

    it("never asks the machine whether it is answering yet", async () => {
        enabled = false;
        render(<HomeSettingsView storage="this server" canAdmin />);
        await painted();
        const once = asked;
        await act(async () => {
            vi.advanceTimersByTime(30_000);
            await Promise.resolve();
        });
        expect(asked).toBe(once);
    });
});

describe("a recognizer that is still starting", () => {
    it("says so, and says it is running once it answers - without a reload", async () => {
        render(<HomeSettingsView storage="this server" canAdmin />);
        await painted();
        expect(screen.getByText("Starting on this server.")).toBeDefined();

        // It comes up while the screen is open, which is the case that was broken.
        answering = true;
        await act(async () => {
            vi.advanceTimersByTime(5000);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(screen.getByText("Running on this server.")).toBeDefined();
    });

    it("stops asking once it is answering", async () => {
        answering = true;
        render(<HomeSettingsView storage="this server" canAdmin />);
        await painted();
        expect(screen.getByText("Running on this server.")).toBeDefined();

        const settled = asked;
        await act(async () => {
            vi.advanceTimersByTime(30_000);
            await Promise.resolve();
        });
        expect(asked).toBe(settled);
    });
});
