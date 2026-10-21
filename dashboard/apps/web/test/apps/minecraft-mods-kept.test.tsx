// @vitest-environment jsdom

/**
 * The mods screen paints what it last read.
 *
 * Asking Modrinth about a list of twenty is a few round trips to somebody else's
 * index, and a server's own log behind them, so a revisit that waits on all of
 * it shows skeletons for seconds over a list that has not changed. The last
 * reading of the same list is drawn at once and the answer this visit gets
 * replaces it only where something moved.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";
import type { InstalledAppSetting } from "@/lib/apps/install-service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    MinecraftMods,
    modBrowseKey,
    modListKey
} from "@polaris-app/game-servers/src/screens/installed/minecraft-mods";
// The dashboard's pieces the screen takes, as the layout provides them.
import "@/components/app-host/client";

vi.mock("@polaris-app/game-servers/src/screens/installed/minecraft-actions", () => ({
    updateServerSettingsAction: vi.fn()
}));

const SUBJECT = "server-1:fabric:1.21.4";

function settings(projects: string): InstalledAppSetting[] {
    return [
        { key: "MODRINTH_PROJECTS", label: "Mods and plugins", value: projects },
        { key: "MODRINTH_DOWNLOAD_DEPENDENCIES", label: "Dependencies", value: "required" },
        { key: "TYPE", label: "Server software", value: "FABRIC" },
        { key: "VERSION", label: "Version", value: "1.21.4" }
    ];
}

function row(entry: string, title: string) {
    return {
        entry,
        slug: entry,
        title,
        description: "",
        downloads: 0,
        categories: [],
        iconUrl: null,
        author: null,
        clientOnly: false,
        serverOnly: false,
        clientOptional: false,
        known: true,
        fitsVersion: true,
        fitsLoader: true
    };
}

function reading(title: string) {
    return { projects: [row("sodium", title)], conflicts: [], requires: [], refused: [] };
}

/** A fetch whose answers are held until a test lets them go. */
function heldFetch(): { release: (installed: unknown, browse: unknown) => void } {
    let release: (installed: unknown, browse: unknown) => void = () => undefined;
    const gate = new Promise<[unknown, unknown]>((resolve) => {
        release = (installed, browse) => resolve([installed, browse]);
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL) => {
            const [installed, browse] = await gate;
            const body = input.toString().includes("installed=") ? installed : browse;
            return { ok: true, json: async () => body } as unknown as Response;
        })
    );
    return { release: (installed, browse) => release(installed, browse) };
}

const SETTLED = { timeout: 5000 };

beforeEach(() => sessionStorage.clear());

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("the installed list", () => {
    it("draws the kept reading before any request has answered", () => {
        writeSnapshot(modListKey(SUBJECT, ["sodium"]), reading("Sodium (kept)"));
        heldFetch();
        render(
            <MinecraftMods
                installedAppId="server-1"
                settings={settings("sodium")}
                playersOnline={0}
                onSaved={vi.fn()}
            />
        );

        // Synchronously: no skeleton first, no wait for the network.
        expect(screen.getByText("Sodium (kept)")).toBeTruthy();
    });

    it("swaps in this visit's answer when it differs, and keeps it", async () => {
        writeSnapshot(modListKey(SUBJECT, ["sodium"]), reading("Sodium (kept)"));
        const fetches = heldFetch();
        render(
            <MinecraftMods
                installedAppId="server-1"
                settings={settings("sodium")}
                playersOnline={0}
                onSaved={vi.fn()}
            />
        );
        fetches.release(reading("Sodium (fresh)"), { projects: [] });

        expect(await screen.findByText("Sodium (fresh)", {}, SETTLED)).toBeTruthy();
        expect(screen.queryByText("Sodium (kept)")).toBeNull();
        const kept = readSnapshot<ReturnType<typeof reading>>(
            modListKey(SUBJECT, ["sodium"]),
            60_000
        );
        expect(kept?.value.projects[0]?.title).toBe("Sodium (fresh)");
    });

    it("keeps a reading per list, so an edited list is not drawn from another's", () => {
        expect(modListKey(SUBJECT, ["sodium"])).not.toBe(
            modListKey(SUBJECT, ["sodium", "lithium"])
        );
        expect(modListKey(SUBJECT, ["sodium"])).not.toBe(
            modListKey("server-2:fabric:1.21.4", ["sodium"])
        );
    });
});

describe("the marketplace", () => {
    it("draws the kept answer to the same browse at once", () => {
        writeSnapshot(modBrowseKey(SUBJECT, "", ""), [
            { ...row("lithium", "Lithium (kept)"), versions: [] }
        ]);
        heldFetch();
        render(
            <MinecraftMods
                installedAppId="server-1"
                settings={settings("")}
                playersOnline={0}
                onSaved={vi.fn()}
            />
        );

        expect(screen.getByText("Lithium (kept)")).toBeTruthy();
    });

    it("keeps the shelf a tab opens on, not every search typed", async () => {
        const fetches = heldFetch();
        render(
            <MinecraftMods
                installedAppId="server-1"
                settings={settings("")}
                playersOnline={0}
                onSaved={vi.fn()}
            />
        );
        fetches.release(reading("unused"), {
            projects: [{ ...row("lithium", "Lithium"), versions: [] }]
        });

        expect(await screen.findByText("Lithium", {}, SETTLED)).toBeTruthy();
        expect(readSnapshot(modBrowseKey(SUBJECT, "", ""), 60_000)).not.toBeNull();
        for (const box of screen.getAllByRole("textbox", { name: /modrinth/i }))
            fireEvent.change(box, { target: { value: "lith" } });
        await waitFor(
            () =>
                expect(
                    vi
                        .mocked(fetch)
                        .mock.calls.some(([input]) => input.toString().includes("query=lith&"))
                ).toBe(true),
            SETTLED
        );
        await act(async () => await new Promise((resolve) => setTimeout(resolve, 50)));
        expect(readSnapshot(modBrowseKey(SUBJECT, "lith", ""), 60_000)).toBeNull();
    });
});

describe("what a list keeps", () => {
    it("keeps one reading per server, dropping the list it replaced", async () => {
        writeSnapshot(modListKey(SUBJECT, ["lithium"]), reading("Lithium (old list)"));
        const fetches = heldFetch();
        render(
            <MinecraftMods
                installedAppId="server-1"
                settings={settings("sodium")}
                playersOnline={0}
                onSaved={vi.fn()}
            />
        );
        fetches.release(reading("Sodium (fresh)"), { projects: [] });

        expect(await screen.findByText("Sodium (fresh)", {}, SETTLED)).toBeTruthy();
        expect(readSnapshot(modListKey(SUBJECT, ["lithium"]), 60_000)).toBeNull();
        expect(readSnapshot(modListKey(SUBJECT, ["sodium"]), 60_000)).not.toBeNull();
    });
});
