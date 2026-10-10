// @vitest-environment jsdom

/**
 * The Sounds tab: drawn before the server answers, then the library, how the
 * sounds reach players, and the moments a sound can be put on.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const SERVER = "00000000-0000-4000-8000-0000000000a1";

let answerView: (value: unknown) => void = () => undefined;

vi.mock("@polaris/app-host/client", async () => {
    const { useLayoutEffect } = await import("react");
    return {
        hostUi: {
            liveRead: { useKeptSnapshot: () => useLayoutEffect(() => undefined, []) },
            snapshotCache: {
                readSnapshot: () => null,
                writeSnapshot: () => undefined,
                dropSnapshots: () => undefined
            },
            structuralMerge: { mergeUnchanged: <T,>(_previous: T, next: T) => next },
            confirmDialog: { useConfirm: () => [async () => true, null] },
            i18nProvider: { useLocale: () => "en-US" }
        }
    };
});
vi.mock("@polaris-app/game-servers/src/screens/installed/sounds-actions", () => ({
    soundsAction: () =>
        new Promise((resolve) => {
            answerView = resolve;
        }),
    liveSoundsAction: async () => ({
        live: {
            running: true,
            loaded: true,
            sha1: "a".repeat(40),
            players: [{ name: "Ana", state: "loaded" }]
        }
    }),
    updateSoundAction: async () => ({}),
    deleteSoundAction: async () => ({}),
    saveSoundSettingsAction: async () => ({}),
    playSoundAction: async () => ({}),
    pushSoundsAction: async () => ({}),
    enableSoundsAction: async () => ({}),
    serverPackAction: async () => ({})
}));
vi.mock("@polaris-app/game-servers/src/screens/installed/restart-actions", () => ({
    restartGameNowAction: async () => ({})
}));

const { MinecraftSounds } = await import(
    "@polaris-app/game-servers/src/screens/installed/minecraft-sounds"
);

afterEach(cleanup);

const VIEW = {
    library: {
        sounds: [
            {
                id: "0190c0de-0000-7000-8000-000000000001",
                key: "victory_fanfare",
                name: "Victory fanfare",
                size: 20_480,
                seconds: 2.5,
                channels: 2,
                subtitle: "",
                stream: false,
                replaces: "",
                updatedAt: "2026-10-10T00:00:00.000Z"
            }
        ],
        settings: {
            required: false,
            prompt: "",
            moments: { win: { sound: "victory_fanfare", volume: 1, pitch: 1 } },
            players: []
        },
        totalBytes: 20_480
    },
    delivery: {
        mode: "jar",
        kind: "plugin",
        ready: true,
        reachable: true,
        serverPackFree: true,
        serverPackOn: false,
        latestUrl: "https://polaris.example/x"
    }
};

function draw(): void {
    render(
        <MinecraftSounds
            installedAppId={SERVER}
            canManage
            canPlay
            running
            players={["Ana"]}
            edition="java"
        />
    );
}

describe("the Sounds tab", () => {
    it("draws its heading and library card before the server answers", () => {
        draw();
        expect(screen.getByText("Custom sounds")).toBeTruthy();
        expect(screen.getByText("Sound library")).toBeTruthy();
    });

    it("lists the library, the live state and the moments once it has", async () => {
        draw();
        answerView({ view: VIEW });
        await waitFor(() =>
            expect(screen.getAllByText("Victory fanfare").length).toBeGreaterThan(0)
        );
        expect(screen.getByText("polaris:victory_fanfare")).toBeTruthy();
        expect(screen.getByText("Live on this server")).toBeTruthy();
        await waitFor(() =>
            expect(screen.getByText("1 of 1 online have the sounds loaded.")).toBeTruthy()
        );
        expect(screen.getByText("Winner")).toBeTruthy();
        expect(screen.getByText("Players' own arrival sounds")).toBeTruthy();
    });

    it("says plainly that Bedrock servers cannot play them", () => {
        render(
            <MinecraftSounds
                installedAppId={SERVER}
                canManage
                canPlay
                running
                players={[]}
                edition="bedrock"
            />
        );
        expect(
            screen.getByText("Bedrock servers cannot play custom sounds from Polaris.")
        ).toBeTruthy();
    });
});
